// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local Cache API simulator, adapted from Miniflare's cache plugin workers
 * (`workers-sdk/packages/miniflare/src/workers/cache/*`), collapsed into a
 * single worker. Utilities from Miniflare's `workers/shared/*` live in
 * `internal/shared.worker.ts`.
 *
 * A single `cache` service hosts every cache. The default export is the entry
 * `fetch` handler that the user worker's `cacheApiOutbound` designator
 * targets: workerd speaks an HTTP protocol to it (`GET` for `match`, `PUT`
 * with a serialised HTTP response body for `put`, `PURGE` for `delete`),
 * setting the `cf-cache-namespace` header for named caches (`caches.open()`)
 * and omitting it for `caches.default`. The handler reads `enabled` from
 * `ctx.props` (set on the `cacheApiOutbound` designator): when disabled every
 * operation is a no-op, otherwise the request is forwarded to the
 * `CacheObject` Durable Object instance for the addressed cache. Entry
 * metadata lives in Durable Object SQLite, response bodies are stored as blob
 * files via the `cache:storage` disk service.
 */
import CachePolicy from "http-cache-semantics";
import type {
  InclusiveRange,
  MultipartReadableStream,
} from "../../internal/shared.worker.ts";
import {
  assert,
  BlobStore,
  HttpError,
  KeyValueStorage,
  parseRanges,
  Timers,
} from "../../internal/shared.worker.ts";
import type { CacheServiceProps } from "./CacheOptions.shared.ts";
import {
  BINDING_CACHE_BLOBS,
  BINDING_CACHE_ENABLE_CONTROL_ENDPOINTS,
  BINDING_CACHE_OBJECT,
  HEADER_CACHE_CONTROL_OP,
  HEADER_CACHE_NAMESPACE,
  HEADER_CACHE_OBJECT_NAME,
  HEADER_CACHE_STATUS,
} from "./CacheOptions.shared.ts";
import { parseHttpResponse } from "./parse-http.shared.ts";

interface Env {
  [BINDING_CACHE_OBJECT]: DurableObjectNamespace;
  [BINDING_CACHE_BLOBS]: Fetcher;
  [BINDING_CACHE_ENABLE_CONTROL_ENDPOINTS]?: boolean;
}

export default {
  async fetch(request, env, ctx) {
    const { enabled } = (ctx as { props: CacheServiceProps }).props;
    if (!enabled) return noopFetch(request);

    // (`cache-entry.worker.ts` upstream)
    const namespace = request.headers.get(HEADER_CACHE_NAMESPACE);
    const name = namespace === null ? "default" : `named:${namespace}`;
    const stub = env[BINDING_CACHE_OBJECT].getByName(name);
    const headers = new Headers(request.headers);
    headers.set(HEADER_CACHE_OBJECT_NAME, encodeURIComponent(name));
    // `request.cf` (carrying `cacheKey`) isn't forwarded implicitly, so pass
    // it explicitly (mirrors upstream `cache-entry.worker.ts`)
    return stub.fetch(new Request(request, { headers }), {
      cf: request.cf as Record<string, unknown>,
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * No-op implementation used when caching is disabled
 * (`cache-entry-noop.worker.ts` upstream).
 */
async function noopFetch(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return new Response(null, {
      status: 504,
      headers: { [HEADER_CACHE_STATUS]: "MISS" },
    });
  } else if (request.method === "PUT") {
    // Must consume request body, otherwise get "disconnected: read end of
    // pipe was aborted" error from workerd
    await request.body?.pipeTo(new WritableStream());
    return new Response(null, { status: 204 });
  } else if (request.method === "PURGE") {
    return new Response(null, { status: 404 });
  } else {
    return new Response(null, { status: 405 });
  }
}

// -----------------------------------------------------------------------------
// Errors (`workers/cache/errors.worker.ts`)
// -----------------------------------------------------------------------------

class CacheError extends HttpError {
  constructor(
    code: number,
    message: string,
    readonly headers: HeadersInit = [],
  ) {
    super(code, message);
  }

  override toResponse(): Response {
    return new Response(null, {
      status: this.code,
      headers: this.headers,
    });
  }
}

class StorageFailure extends CacheError {
  constructor() {
    super(413, "Cache storage failed");
  }
}

class PurgeFailure extends CacheError {
  constructor() {
    super(404, "Couldn't find asset to purge");
  }
}

class CacheMiss extends CacheError {
  constructor() {
    super(
      // workerd ignores this, but it's the correct status code
      504,
      "Asset not found in cache",
      [[HEADER_CACHE_STATUS, "MISS"]],
    );
  }
}

class RangeNotSatisfiable extends CacheError {
  constructor(size: number) {
    super(416, "Range not satisfiable", [
      ["Content-Range", `bytes */${size}`],
      [HEADER_CACHE_STATUS, "HIT"],
    ]);
  }
}

// -----------------------------------------------------------------------------
// Cache Durable Object (`workers/cache/cache.worker.ts`)
// -----------------------------------------------------------------------------

interface CacheMetadata {
  headers: Array<Array<string>>;
  status: number;
  size: number;
}

type CacheRequest = Request<unknown, RequestInitCfProperties>;

function getCacheKey(req: CacheRequest): string {
  return req.cf?.cacheKey ? String(req.cf?.cacheKey) : req.url;
}

function getExpiration(timers: Timers, req: Request, res: Response) {
  // Cloudflare ignores request Cache-Control
  const reqHeaders = normaliseHeaders(req.headers);
  delete reqHeaders["cache-control"];

  // Cloudflare never caches responses with Set-Cookie headers
  // If Cache-Control contains private=set-cookie, Cloudflare will remove
  // the Set-Cookie header automatically
  const resHeaders = normaliseHeaders(res.headers);
  if (
    resHeaders["cache-control"]?.toLowerCase().includes("private=set-cookie")
  ) {
    resHeaders["cache-control"] = resHeaders["cache-control"]
      ?.toLowerCase()
      .replace(/private=set-cookie;?/i, "");
    delete resHeaders["set-cookie"];
  }

  // Build request and responses suitable for CachePolicy
  const cacheReq: CachePolicy.Request = {
    url: req.url,
    // If a request gets to the Cache service, its method will be GET, as
    // workerd only caches GET requests
    method: "GET",
    headers: reqHeaders,
  };
  const cacheRes: CachePolicy.Response = {
    status: res.status,
    headers: resHeaders,
  };

  // @ts-expect-error `now` isn't included in CachePolicy's type definitions
  const originalNow = CachePolicy.prototype.now;
  // @ts-expect-error `now` isn't included in CachePolicy's type definitions
  CachePolicy.prototype.now = timers.now;
  try {
    const policy = new CachePolicy(cacheReq, cacheRes, { shared: true });

    return {
      // Check if the request & response is cacheable
      storable: policy.storable() && !("set-cookie" in resHeaders),
      expiration: policy.timeToLive(),
      // Cache Policy Headers is typed as [header: string]: string | string[] | undefined
      // It's safe to ignore the undefined here, which is what casting to HeadersInit does
      headers: policy.responseHeaders() as HeadersInit,
    };
  } finally {
    // @ts-expect-error `now` isn't included in CachePolicy's type definitions
    CachePolicy.prototype.now = originalNow;
  }
}

// Normalises headers to object mapping lower-case names to single values.
// Single values are OK here as the headers we care about for determining
// cache-ability are all single-valued, and we store the raw, multi-valued
// headers in KV once this has been determined.
function normaliseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers) result[key.toLowerCase()] = value;
  return result;
}

// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag#syntax
const etagRegexp = /^(W\/)?"(.+)"$/;
function parseETag(value: string): string | undefined {
  // As we only use this for `If-None-Match` handling, which always uses the
  // weak comparison algorithm, ignore "W/" directives:
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match
  return etagRegexp.exec(value.trim())?.[2] ?? undefined;
}

// https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.1.1
const utcDateRegexp =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d\d\d \d\d:\d\d:\d\d GMT$/;
function parseUTCDate(value: string): number {
  return utcDateRegexp.test(value) ? Date.parse(value) : NaN;
}

interface CachedResponse {
  status: number;
  headers: Headers;
  ranges: Array<InclusiveRange>;
  body: ReadableStream<Uint8Array> | MultipartReadableStream;
  totalSize: number;
}
function getMatchResponse(reqHeaders: Headers, res: CachedResponse): Response {
  // If `If-None-Match` is set, perform a conditional request:
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match
  const reqIfNoneMatchHeader = reqHeaders.get("If-None-Match");
  const resETagHeader = res.headers.get("ETag");
  if (reqIfNoneMatchHeader !== null && resETagHeader !== null) {
    const resETag = parseETag(resETagHeader);
    if (resETag !== undefined) {
      if (reqIfNoneMatchHeader.trim() === "*") {
        return new Response(null, { status: 304, headers: res.headers });
      }
      for (const reqIfNoneMatch of reqIfNoneMatchHeader.split(",")) {
        if (resETag === parseETag(reqIfNoneMatch)) {
          return new Response(null, { status: 304, headers: res.headers });
        }
      }
    }
  }

  // If `If-Modified-Since` is set, perform a conditional request:
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since
  const reqIfModifiedSinceHeader = reqHeaders.get("If-Modified-Since");
  const resLastModifiedHeader = res.headers.get("Last-Modified");
  if (reqIfModifiedSinceHeader !== null && resLastModifiedHeader !== null) {
    const reqIfModifiedSince = parseUTCDate(reqIfModifiedSinceHeader);
    const resLastModified = parseUTCDate(resLastModifiedHeader);
    // Comparison of NaN's (invalid dates), will always result in `false`
    if (resLastModified <= reqIfModifiedSince) {
      return new Response(null, { status: 304, headers: res.headers });
    }
  }

  // If `Range` was set, return a partial response:
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range
  if (res.ranges.length > 0) {
    res.status = 206; // Partial Content
    if (res.ranges.length > 1) {
      assert(!(res.body instanceof ReadableStream)); // assert(isMultipart)
      res.headers.set("Content-Type", res.body.multipartContentType);
    } else {
      const { start, end } = res.ranges[0];
      res.headers.set(
        "Content-Range",
        `bytes ${start}-${end}/${res.totalSize}`,
      );
      res.headers.set("Content-Length", `${end - start + 1}`);
    }
  }

  if (!(res.body instanceof ReadableStream)) res.body = res.body.body;
  return new Response(res.body, { status: res.status, headers: res.headers });
}

class SizingStream extends TransformStream<Uint8Array, Uint8Array> {
  readonly size: Promise<number>;

  constructor() {
    let resolveSize!: (size: number) => void;
    const sizePromise = new Promise<number>(
      (resolve) => (resolveSize = resolve),
    );
    let size = 0;
    super({
      transform(chunk, controller) {
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        resolveSize(size);
      },
    });
    this.size = sizePromise;
  }
}

interface ControlOp {
  name: string;
  args?: Array<unknown>;
}

export class CacheObject implements DurableObject {
  readonly timers = new Timers();

  #name?: string;
  #blob?: BlobStore;
  #storage?: KeyValueStorage<CacheMetadata>;

  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  get name(): string {
    // `name` is initialised from the name header on first request
    assert(
      this.#name !== undefined,
      "Expected `CacheObject#fetch()` call before `name` access",
    );
    return this.#name;
  }

  get blob(): BlobStore {
    return (this.#blob ??= new BlobStore(
      this.env[BINDING_CACHE_BLOBS],
      this.name,
    ));
  }

  get storage(): KeyValueStorage<CacheMetadata> {
    // `KeyValueStorage` can only be constructed once `this.blob` is initialised
    return (this.#storage ??= new KeyValueStorage(
      this.state.storage,
      this.blob,
      this.timers,
    ));
  }

  async fetch(req: Request): Promise<Response> {
    // Each request includes the cache name, so the `BlobStore` can be
    // namespaced by it (mirrors Miniflare's persistence format, which
    // namespaces blobs by name rather than Durable Object ID).
    const encodedName = req.headers.get(HEADER_CACHE_OBJECT_NAME);
    assert(encodedName !== null, `Expected ${HEADER_CACHE_OBJECT_NAME} header`);
    this.#name = decodeURIComponent(encodedName);

    // Allow control of object internals via a reserved header. Used by tests
    // to update fake time and access internal storage.
    if (this.env[BINDING_CACHE_ENABLE_CONTROL_ENDPOINTS] === true) {
      const controlOpHeader = req.headers.get(HEADER_CACHE_CONTROL_OP);
      if (controlOpHeader !== null) {
        const controlOp = (await req.json()) as ControlOp;
        return this.#handleControlOp(controlOp);
      }
    }

    try {
      return await this.#route(req as CacheRequest);
    } catch (e) {
      if (e instanceof HttpError) return e.toResponse();
      const error = e instanceof Error ? e : new Error(String(e));
      const fallback = error.stack ?? error.message;
      console.error(fallback);
      return new Response(fallback, { status: 500 });
    } finally {
      // Make sure the request body is consumed. Otherwise, calls which make
      // requests to this object may hang and never resolve.
      // See https://github.com/cloudflare/workerd/issues/960.
      if (req.body !== null && !req.bodyUsed) {
        await req.body.pipeTo(new WritableStream());
      }
    }
  }

  async #handleControlOp({ name, args = [] }: ControlOp): Promise<Response> {
    if (name === "sqlQuery") {
      // Run an arbitrary SQL query (e.g. get the blob ID for a key)
      const [query, ...params] = args;
      assert(typeof query === "string");
      const results = this.state.storage.sql
        .exec(query, ...(params as Array<SqlStorageValue>))
        .toArray();
      return Response.json(results);
    } else if (name === "getBlob") {
      // Get an arbitrary blob
      const [id] = args;
      assert(typeof id === "string");
      const stream = await this.blob.get(id);
      return new Response(stream, { status: stream === null ? 404 : 200 });
    } else {
      // Enable/disable fake timers, advance time, or wait for tasks
      const func: unknown = this.timers[name as keyof Timers];
      assert(typeof func === "function", `Unknown control op: ${name}`);
      const result = await (func as (...args: Array<unknown>) => unknown).apply(
        this.timers,
        args,
      );
      return Response.json(result ?? null);
    }
  }

  #route(req: CacheRequest): Promise<Response> | Response {
    switch (req.method) {
      case "GET":
        return this.#match(req);
      case "PUT":
        return this.#put(req);
      case "PURGE":
        return this.#delete(req);
      default:
        return new Response(null, { status: 405 });
    }
  }

  async #match(req: CacheRequest): Promise<Response> {
    const cacheKey = getCacheKey(req);

    let resHeaders: Headers | undefined;
    let resRanges: Array<InclusiveRange> | undefined;

    const cached = await this.storage.get(cacheKey, ({ size, headers }) => {
      resHeaders = new Headers(headers as HeadersInit);
      const contentType = resHeaders.get("Content-Type");

      // Need size from metadata to parse `Range` header
      const rangeHeader = req.headers.get("Range");
      if (rangeHeader !== null) {
        resRanges = parseRanges(rangeHeader, size);
        if (resRanges === undefined) throw new RangeNotSatisfiable(size);
      }

      return {
        ranges: resRanges,
        contentLength: size,
        contentType: contentType ?? undefined,
      };
    });
    if (cached?.metadata === undefined) throw new CacheMiss();

    // Should've constructed headers when we extracted range options (the only
    // time we don't do this is when the entry isn't found, or expired, in
    // which case, we just threw a `CacheMiss`)
    assert(resHeaders !== undefined);
    resHeaders.set("CF-Cache-Status", "HIT");
    resRanges ??= [];

    return getMatchResponse(req.headers, {
      status: cached.metadata.status,
      headers: resHeaders,
      ranges: resRanges,
      body: cached.value,
      totalSize: cached.metadata.size,
    });
  }

  async #put(req: CacheRequest): Promise<Response> {
    const cacheKey = getCacheKey(req);

    assert(req.body !== null);
    const res = await parseHttpResponse(req.body);
    let body = res.body;
    assert(body !== null);

    const { storable, expiration, headers } = getExpiration(
      this.timers,
      req,
      res,
    );
    if (!storable) {
      // Make sure `body` is consumed to avoid `TypeError: Can't read from
      // request stream after response has been sent.`
      try {
        await body.pipeTo(new WritableStream());
      } catch {}
      throw new StorageFailure();
    }

    // If we know the size, avoid passing the body through a transform stream
    // to count it (trusting `workerd` to send correct value here).
    const contentLength = parseInt(res.headers.get("Content-Length") ?? "NaN");
    let sizePromise: Promise<number>;
    if (Number.isNaN(contentLength)) {
      const stream = new SizingStream();
      body = body.pipeThrough(stream);
      sizePromise = stream.size;
    } else {
      sizePromise = Promise.resolve(contentLength);
    }

    const metadata: Promise<CacheMetadata> = sizePromise.then((size) => ({
      headers: Object.entries(headers),
      status: res.status,
      size,
    }));

    await this.storage.put({
      key: cacheKey,
      value: body,
      expiration: this.timers.now() + expiration,
      metadata,
    });
    return new Response(null, { status: 204 });
  }

  async #delete(req: CacheRequest): Promise<Response> {
    const cacheKey = getCacheKey(req);

    const deleted = await this.storage.delete(cacheKey);
    // This is an extremely vague error, but it fits with what the cache API
    // in workerd expects
    if (!deleted) throw new PurgeFailure();
    return new Response(null);
  }
}
