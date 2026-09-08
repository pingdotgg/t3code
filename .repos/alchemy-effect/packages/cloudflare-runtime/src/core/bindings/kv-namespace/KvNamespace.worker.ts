// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local KV namespace simulator, adapted from Miniflare's KV plugin workers
 * (`workers-sdk/packages/miniflare/src/workers/kv/*`), collapsed into a
 * single worker. Utilities from Miniflare's `workers/shared/*` live in
 * `internal/shared.worker.ts`.
 *
 * A single `kv` service hosts every namespace. The default export is the
 * entry `fetch` handler that `kvNamespace` bindings target: it reads the
 * namespace id from `ctx.props` (set on the binding's service designator) and
 * forwards the request to the `KVNamespaceObject` Durable Object instance for
 * that namespace. The Durable Object speaks workerd's KV binding HTTP
 * protocol: key metadata lives in Durable Object SQLite, values are stored as
 * blob files via the `kv:storage` disk service.
 */
import type { KeyValueEntry } from "../../internal/shared.worker.ts";
import {
  assert,
  BlobStore,
  HttpError,
  KeyValueStorage,
  maybeApply,
  Timers,
  utf8ByteLength,
} from "../../internal/shared.worker.ts";
import type { KvServiceProps } from "./KvNamespaceOptions.shared.ts";
import {
  BINDING_KV_BLOBS,
  BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
  BINDING_KV_OBJECT,
  HEADER_KV_CONTROL_OP,
  HEADER_KV_NAMESPACE,
} from "./KvNamespaceOptions.shared.ts";

interface Env {
  [BINDING_KV_OBJECT]: DurableObjectNamespace;
  [BINDING_KV_BLOBS]: Fetcher;
  [BINDING_KV_ENABLE_CONTROL_ENDPOINTS]?: boolean;
}

export default {
  async fetch(request, env, ctx) {
    const { namespaceId } = (ctx as { props: KvServiceProps }).props;
    const stub = env[BINDING_KV_OBJECT].getByName(namespaceId);
    const headers = new Headers(request.headers);
    headers.set(HEADER_KV_NAMESPACE, encodeURIComponent(namespaceId));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------
// Constants (`workers/kv/constants.ts`)
// -----------------------------------------------------------------------------

const KVLimits = {
  MIN_CACHE_TTL_SECONDS: 30,
  MIN_EXPIRATION_TTL_SECONDS: 60,
  MAX_LIST_KEYS: 1000,
  MAX_KEY_SIZE_BYTES: 512,
  MAX_VALUE_SIZE_BYTES: 25 * 1024 * 1024 /* 25MiB */,
  MAX_VALUE_SIZE_TEST_BYTES: 1024 /* 1KiB */,
  MAX_METADATA_SIZE_BYTES: 1024 /* 1KiB */,
  MAX_BULK_SIZE_BYTES: 25 * 1024 * 1024 /* 25MiB */,
} as const;

const KVParams = {
  URL_ENCODED: "urlencoded",
  CACHE_TTL: "cache_ttl",
  EXPIRATION: "expiration",
  EXPIRATION_TTL: "expiration_ttl",
  LIST_LIMIT: "key_count_limit",
  LIST_PREFIX: "prefix",
  LIST_CURSOR: "cursor",
} as const;

const KVHeaders = {
  EXPIRATION: "CF-Expiration",
  METADATA: "CF-KV-Metadata",
} as const;

const MAX_BULK_GET_KEYS = 100;

// -----------------------------------------------------------------------------
// Validation (`workers/kv/validator.worker.ts`)
// -----------------------------------------------------------------------------

function decodeKey(key: string, query: URLSearchParams): string {
  if (query.get(KVParams.URL_ENCODED)?.toLowerCase() !== "true") return key;
  try {
    return decodeURIComponent(key);
  } catch (e) {
    if (e instanceof URIError) {
      throw new HttpError(400, "Could not URL-decode key name");
    } else {
      throw e;
    }
  }
}

function validateKey(key: string): void {
  if (key === "") {
    throw new HttpError(400, "Key names must not be empty");
  }
  if (key === "." || key === "..") {
    throw new HttpError(
      400,
      `Illegal key name "${key}". Please use a different name.`,
    );
  }
  validateKeyLength(key);
}

function validateKeyLength(key: string): void {
  const keyLength = utf8ByteLength(key);
  if (keyLength > KVLimits.MAX_KEY_SIZE_BYTES) {
    throw new HttpError(
      414,
      `UTF-8 encoded length of ${keyLength} exceeds key length limit of ${KVLimits.MAX_KEY_SIZE_BYTES}.`,
    );
  }
}

function validateGetOptions(
  key: string,
  options?: { cacheTtl?: number },
): void {
  validateKey(key);
  // Validate cacheTtl, but ignore it as there's only one "edge location":
  // the user's computer
  const cacheTtl = options?.cacheTtl;
  if (
    cacheTtl !== undefined &&
    (isNaN(cacheTtl) || cacheTtl < KVLimits.MIN_CACHE_TTL_SECONDS)
  ) {
    throw new HttpError(
      400,
      `Invalid ${KVParams.CACHE_TTL} of ${cacheTtl}. Cache TTL must be at least ${KVLimits.MIN_CACHE_TTL_SECONDS}.`,
    );
  }
}

function validatePutOptions(
  key: string,
  options: {
    now: number /* seconds */;
    rawExpiration: string /* seconds */ | null;
    rawExpirationTtl: string /* seconds */ | null;
    rawMetadata: string /* JSON */ | null;
  },
): { expiration?: number /* seconds */; metadata?: unknown } {
  const { now, rawExpiration, rawExpirationTtl, rawMetadata } = options;

  validateKey(key);

  // Validate expiration
  let expiration: number | undefined;
  if (rawExpirationTtl !== null) {
    const expirationTtl = parseInt(rawExpirationTtl);
    if (Number.isNaN(expirationTtl) || expirationTtl <= 0) {
      throw new HttpError(
        400,
        `Invalid ${KVParams.EXPIRATION_TTL} of ${rawExpirationTtl}. Please specify integer greater than 0.`,
      );
    }
    if (expirationTtl < KVLimits.MIN_EXPIRATION_TTL_SECONDS) {
      throw new HttpError(
        400,
        `Invalid ${KVParams.EXPIRATION_TTL} of ${rawExpirationTtl}. Expiration TTL must be at least ${KVLimits.MIN_EXPIRATION_TTL_SECONDS}.`,
      );
    }
    expiration = now + expirationTtl;
  } else if (rawExpiration !== null) {
    expiration = parseInt(rawExpiration);
    if (Number.isNaN(expiration) || expiration <= now) {
      throw new HttpError(
        400,
        `Invalid ${KVParams.EXPIRATION} of ${rawExpiration}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
      );
    }
    if (expiration < now + KVLimits.MIN_EXPIRATION_TTL_SECONDS) {
      throw new HttpError(
        400,
        `Invalid ${KVParams.EXPIRATION} of ${rawExpiration}. Expiration times must be at least ${KVLimits.MIN_EXPIRATION_TTL_SECONDS} seconds in the future.`,
      );
    }
  }

  // Validate metadata size
  let metadata: unknown;
  if (rawMetadata !== null) {
    const metadataLength = utf8ByteLength(rawMetadata);
    if (metadataLength > KVLimits.MAX_METADATA_SIZE_BYTES) {
      throw new HttpError(
        413,
        `Metadata length of ${metadataLength} exceeds limit of ${KVLimits.MAX_METADATA_SIZE_BYTES}.`,
      );
    }
    metadata = JSON.parse(rawMetadata);
  }

  return { expiration, metadata };
}

function decodeListOptions(url: URL) {
  const limitParam = url.searchParams.get(KVParams.LIST_LIMIT);
  const limit =
    limitParam === null ? KVLimits.MAX_LIST_KEYS : parseInt(limitParam);
  const prefix = url.searchParams.get(KVParams.LIST_PREFIX) ?? undefined;
  const cursor = url.searchParams.get(KVParams.LIST_CURSOR) ?? undefined;
  return { limit, prefix, cursor };
}

function validateListOptions(options: {
  limit: number;
  prefix?: string;
}): void {
  // Validate key limit
  const limit = options.limit;
  if (limit !== undefined) {
    if (isNaN(limit) || limit < 1) {
      throw new HttpError(
        400,
        `Invalid ${KVParams.LIST_LIMIT} of ${limit}. Please specify an integer greater than 0.`,
      );
    }
    if (limit > KVLimits.MAX_LIST_KEYS) {
      throw new HttpError(
        400,
        `Invalid ${KVParams.LIST_LIMIT} of ${limit}. Please specify an integer less than ${KVLimits.MAX_LIST_KEYS}.`,
      );
    }
  }

  // Validate key prefix
  const prefix = options.prefix;
  if (prefix != null) validateKeyLength(prefix);
}

// -----------------------------------------------------------------------------
// KV namespace Durable Object (`workers/kv/namespace.worker.ts`)
// -----------------------------------------------------------------------------

function createMaxValueSizeError(length: number, maxValueSize: number) {
  return new HttpError(
    413,
    `Value length of ${length} exceeds limit of ${maxValueSize}.`,
  );
}

class MaxLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  readonly signal: AbortSignal;
  readonly length: Promise<number>;

  constructor(maxLength: number) {
    const abortController = new AbortController();
    let resolveLength!: (length: number) => void;
    const lengthPromise = new Promise<number>(
      (resolve) => (resolveLength = resolve),
    );

    let length = 0;
    super({
      transform(chunk, controller) {
        length += chunk.byteLength;
        // If we exceeded the maximum length, don't enqueue the chunk, but
        // don't error the stream, so we get the correct final length in the
        // error message
        if (length <= maxLength) {
          controller.enqueue(chunk);
        } else if (!abortController.signal.aborted) {
          abortController.abort();
        }
      },
      flush() {
        // We can't `error()` the stream on overflow: file-system access goes
        // through `fetch()`, which throws an un-catchable exception when the
        // body stream is aborted. Instead we abort a signal and resolve the
        // observed length for the error message.
        resolveLength(length);
      },
    });

    this.signal = abortController.signal;
    this.length = lengthPromise;
  }
}

function millisToSeconds(millis: number): number {
  return Math.floor(millis / 1000);
}
function secondsToMillis(seconds: number): number {
  return seconds * 1000;
}

async function processKeyValue(
  obj: KeyValueEntry<unknown> | null,
  type: "text" | "json" = "text",
  withMetadata = false,
): Promise<[value: unknown, size: number]> {
  const decoder = new TextDecoder();
  let decodedValue = "";
  if (obj?.value) {
    for await (const chunk of obj.value) {
      decodedValue += decoder.decode(chunk, { stream: true });
    }
    decodedValue += decoder.decode();
  }

  let val = null;
  const size = decodedValue.length;
  try {
    val = !obj?.value
      ? null
      : type === "json"
        ? JSON.parse(decodedValue)
        : decodedValue;
  } catch {
    throw new HttpError(
      400,
      `At least one of the requested keys corresponds to a non-${type} value`,
    );
  }
  if (val && withMetadata) {
    return [{ value: val, metadata: obj?.metadata ?? null }, size];
  }
  return [val, size];
}

interface ControlOp {
  name: string;
  args?: Array<unknown>;
}

const KEY_PATH_REGEXP = /^\/(?<key>[^/]+)\/?$/;
const LIST_PATH_REGEXP = /^\/?$/;
const BULK_GET_PATH_REGEXP = /^\/bulk\/get\/?$/;

export class KVNamespaceObject implements DurableObject {
  readonly timers = new Timers();
  // If this Durable Object receives a control op, assume it's being tested.
  // Used to adjust some limits in tests.
  beingTested = false;

  #name?: string;
  #blob?: BlobStore;
  #storage?: KeyValueStorage;

  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  get name(): string {
    // `name` is initialised from the namespace header on first request
    assert(
      this.#name !== undefined,
      "Expected `KVNamespaceObject#fetch()` call before `name` access",
    );
    return this.#name;
  }

  get blob(): BlobStore {
    return (this.#blob ??= new BlobStore(
      this.env[BINDING_KV_BLOBS],
      this.name,
    ));
  }

  get storage(): KeyValueStorage {
    // `KeyValueStorage` can only be constructed once `this.blob` is initialised
    return (this.#storage ??= new KeyValueStorage(
      this.state.storage,
      this.blob,
      this.timers,
    ));
  }

  async fetch(req: Request): Promise<Response> {
    // Each request includes the namespace id, so the `BlobStore` can be
    // namespaced by it (mirrors Miniflare's persistence format, which
    // namespaces blobs by name rather than Durable Object ID).
    const encodedName = req.headers.get(HEADER_KV_NAMESPACE);
    assert(encodedName !== null, `Expected ${HEADER_KV_NAMESPACE} header`);
    this.#name = decodeURIComponent(encodedName);

    // Allow control of object internals via a reserved header. Used by tests
    // to update fake time and access internal storage.
    if (this.env[BINDING_KV_ENABLE_CONTROL_ENDPOINTS] === true) {
      const controlOpHeader = req.headers.get(HEADER_KV_CONTROL_OP);
      if (controlOpHeader !== null) {
        const controlOp = (await req.json()) as ControlOp;
        return this.#handleControlOp(controlOp);
      }
    }

    try {
      return await this.#route(req);
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
    this.beingTested = true;
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

  #route(req: Request): Promise<Response> | Response {
    const url = new URL(req.url);
    const keyMatch = KEY_PATH_REGEXP.exec(url.pathname);
    const key = keyMatch?.groups?.key;
    switch (req.method) {
      case "GET":
        if (key !== undefined) return this.#get(key, url);
        if (LIST_PATH_REGEXP.test(url.pathname)) return this.#list(url);
        return new Response(null, { status: 404 });
      case "POST":
        if (BULK_GET_PATH_REGEXP.test(url.pathname)) return this.#bulkGet(req);
        return new Response(null, { status: 404 });
      case "PUT":
        if (key !== undefined) return this.#put(req, key, url);
        return new Response(null, { status: 404 });
      case "DELETE":
        if (key !== undefined) return this.#delete(key, url);
        return new Response(null, { status: 404 });
      default:
        return new Response(null, { status: 405 });
    }
  }

  async #get(rawKey: string, url: URL): Promise<Response> {
    // Decode URL parameters
    const key = decodeKey(rawKey, url.searchParams);
    const cacheTtlParam = url.searchParams.get(KVParams.CACHE_TTL);
    const cacheTtl =
      cacheTtlParam === null ? undefined : parseInt(cacheTtlParam);

    // Get value from storage
    validateGetOptions(key, { cacheTtl });
    const entry = await this.storage.get(key);
    if (entry === null) throw new HttpError(404, "Not Found");

    // Return value in runtime-friendly format
    const headers = new Headers();
    if (entry.expiration !== undefined) {
      headers.set(
        KVHeaders.EXPIRATION,
        millisToSeconds(entry.expiration).toString(),
      );
    }
    if (entry.metadata !== undefined) {
      headers.set(KVHeaders.METADATA, JSON.stringify(entry.metadata));
    }
    return new Response(entry.value, { headers });
  }

  async #bulkGet(req: Request): Promise<Response> {
    const parsedBody = (await req.json()) as {
      keys: Array<string>;
      type?: string;
      withMetadata?: boolean;
      cacheTtl?: number;
    };
    const keys = parsedBody.keys;
    const type = parsedBody.type;
    if (type && type !== "text" && type !== "json") {
      const errorStr = `"${type}" is not a valid type. Use "json" or "text"`;
      return new Response(errorStr, { status: 400, statusText: errorStr });
    }
    if (keys.length > MAX_BULK_GET_KEYS) {
      const errorStr = `You can request a maximum of ${MAX_BULK_GET_KEYS} keys`;
      return new Response(errorStr, { status: 400, statusText: errorStr });
    }
    if (keys.length < 1) {
      const errorStr = "You must request a minimum of 1 key";
      return new Response(errorStr, { status: 400, statusText: errorStr });
    }
    const obj: Record<string, unknown> = {};
    let totalBytes = 0;
    for (const key of keys) {
      validateGetOptions(key, { cacheTtl: parsedBody.cacheTtl });
      const entry = await this.storage.get(key);
      const [value, size] = await processKeyValue(
        entry,
        parsedBody.type as "text" | "json" | undefined,
        parsedBody.withMetadata,
      );
      totalBytes += size;
      obj[key] = value;
    }
    const maxValueSize = this.beingTested
      ? KVLimits.MAX_VALUE_SIZE_TEST_BYTES
      : KVLimits.MAX_BULK_SIZE_BYTES;
    if (totalBytes > maxValueSize) {
      throw new HttpError(
        413,
        `Total size of request exceeds the limit of ${maxValueSize / 1024 / 1024}MB`,
      );
    }

    return new Response(JSON.stringify(obj));
  }

  async #put(req: Request, rawKey: string, url: URL): Promise<Response> {
    // Decode URL parameters and headers
    const key = decodeKey(rawKey, url.searchParams);
    const rawExpiration = url.searchParams.get(KVParams.EXPIRATION);
    const rawExpirationTtl = url.searchParams.get(KVParams.EXPIRATION_TTL);
    const rawMetadata = req.headers.get(KVHeaders.METADATA);

    // Validate key, expiration and metadata
    const now = millisToSeconds(this.timers.now());
    const { expiration, metadata } = validatePutOptions(key, {
      now,
      rawExpiration,
      rawExpirationTtl,
      rawMetadata,
    });

    // Validate value size: if we know the value length, avoid passing the body
    // through a transform stream to count it (trusting `workerd` to send a
    // correct value here).
    let value = req.body;
    const contentLength = parseInt(req.headers.get("Content-Length") ?? "NaN");
    let valueLengthHint: number | undefined;
    if (!Number.isNaN(contentLength)) valueLengthHint = contentLength;
    else if (value === null) valueLengthHint = 0;

    // Empty values may be put with `null` bodies:
    // https://github.com/cloudflare/miniflare/issues/703
    value ??= new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const maxValueSize = this.beingTested
      ? KVLimits.MAX_VALUE_SIZE_TEST_BYTES
      : KVLimits.MAX_VALUE_SIZE_BYTES;
    let maxLengthStream: MaxLengthStream | undefined;
    if (valueLengthHint !== undefined && valueLengthHint > maxValueSize) {
      // If we know the size of the value (i.e. from `Content-Length`), use that
      throw createMaxValueSizeError(valueLengthHint, maxValueSize);
    } else {
      // Otherwise, pipe through a transform stream that counts the number of
      // bytes, aborting its signal if the max is exceeded
      maxLengthStream = new MaxLengthStream(maxValueSize);
      value = value.pipeThrough(maxLengthStream);
    }

    // Put value into storage
    try {
      await this.storage.put({
        key,
        value,
        expiration: maybeApply(secondsToMillis, expiration),
        metadata,
        signal: maxLengthStream?.signal,
      });
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "name" in e &&
        e.name === "AbortError"
      ) {
        // `storage.put()` will only throw an abort error once the stream has
        // been written to the blob store (it gets cleaned up afterwards), so
        // we have the correct value length here.
        assert(maxLengthStream !== undefined);
        const length = await maxLengthStream.length;
        throw createMaxValueSizeError(length, maxValueSize);
      } else {
        throw e;
      }
    }

    return new Response();
  }

  async #delete(rawKey: string, url: URL): Promise<Response> {
    // Decode URL parameters
    const key = decodeKey(rawKey, url.searchParams);
    validateKey(key);

    // Delete key from storage
    await this.storage.delete(key);
    return new Response();
  }

  #list(url: URL): Response {
    // Decode URL parameters
    const options = decodeListOptions(url);
    validateListOptions(options);

    // List keys from storage
    const res = this.storage.list(options);
    const keys = res.keys.map<KVNamespaceListKey<unknown>>((key) => ({
      name: key.key,
      expiration: maybeApply(millisToSeconds, key.expiration),
      // workerd expects metadata to be a JSON-serialised string
      metadata: maybeApply(JSON.stringify, key.metadata),
    }));
    let result: KVNamespaceListResult<unknown>;
    if (res.cursor === undefined) {
      result = { keys, list_complete: true, cacheStatus: null };
    } else {
      result = {
        keys,
        list_complete: false,
        cursor: res.cursor,
        cacheStatus: null,
      };
    }
    return Response.json(result);
  }
}
