/**
 * The platform-proxy worker: runs as the user-worker service inside workerd
 * with the caller's bindings attached, and exposes them to Node over HTTP.
 * See {@link ./PlatformProxyProtocol.shared.ts} for the protocol.
 */
/** The request type `ExportedHandler["fetch"]` receives (ambient workers-types globals). */
type WorkerRequest = Request<unknown, IncomingRequestCfProperties<unknown>>;
import type {
  CallRequest,
  EncodedChainSegment,
  EncodedValue,
  EnvBindingDescriptor,
  ResultKind,
} from "./PlatformProxyProtocol.shared.ts";
import {
  BINDING_PLATFORM_PROXY_TOKEN,
  bytesToBase64,
  decodeValue,
  encodeValue,
  HEADER_BINDING,
  HEADER_BYTES_KIND,
  HEADER_CACHE_HEADERS,
  HEADER_CACHE_IGNORE_METHOD,
  HEADER_CACHE_METHOD,
  HEADER_CACHE_NAME,
  HEADER_CACHE_STATUS,
  HEADER_CACHE_URL,
  HEADER_CHAIN,
  HEADER_RESULT,
  HEADER_TOKEN,
  HEADER_URL,
  PATH_CACHE_DELETE,
  PATH_CACHE_MATCH,
  PATH_CACHE_PUT,
  PATH_CALL,
  PATH_ENV,
  PATH_FETCH,
} from "./PlatformProxyProtocol.shared.ts";

interface Env {
  [binding: string]: unknown;
}

class ProxyRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const isTimingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
};

const assertAuthorized = (request: WorkerRequest, env: Env) => {
  const token = request.headers.get(HEADER_TOKEN);
  const expected = env[BINDING_PLATFORM_PROXY_TOKEN];
  if (
    typeof expected !== "string" ||
    !token ||
    !isTimingSafeEqual(token, expected)
  ) {
    throw new ProxyRequestError("platform-proxy: authorization failed", 401);
  }
};

// ---------------------------------------------------------------------------
// Env descriptor
// ---------------------------------------------------------------------------

const isPlainValue = (value: unknown): boolean => {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object": {
      if (value === null) return true;
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
        return true;
      if (Array.isArray(value)) return value.every(isPlainValue);
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        return Object.values(value).every(isPlainValue);
      }
      return false;
    }
    default:
      return false;
  }
};

const describeEnv = (env: Env): { bindings: Array<EnvBindingDescriptor> } => {
  const bindings: Array<EnvBindingDescriptor> = [];
  for (const [name, value] of Object.entries(env)) {
    if (name === BINDING_PLATFORM_PROXY_TOKEN) continue;
    if (isPlainValue(value)) {
      bindings.push({ name, kind: "value", value: encodeValue(value) });
    } else {
      const className = (value as { constructor?: { name?: string } } | null)
        ?.constructor?.name;
      bindings.push({
        name,
        kind: "stub",
        ...(className !== undefined ? { className } : {}),
      });
    }
  }
  return { bindings };
};

// ---------------------------------------------------------------------------
// Chain evaluation (`/call` and the target resolution of `/fetch`)
// ---------------------------------------------------------------------------

const encodeWorkerValue = (value: unknown): EncodedValue | undefined => {
  if (
    typeof value === "object" &&
    value !== null &&
    value.constructor?.name === "DurableObjectId"
  ) {
    const id = value as DurableObjectId;
    return {
      $: "durable-object-id",
      id: id.toString(),
      ...(id.name ? { name: id.name } : {}),
    };
  }
  if (isR2ObjectLike(value)) {
    // Bodyless here (nested positions — e.g. the objects of a `list`
    // result). A top-level `get` result's body is captured by the async
    // pre-pass in `encodeResult`.
    return encodeR2Object(value);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// R2 rich objects (R2Object / R2ObjectBody / R2Objects)
// ---------------------------------------------------------------------------

interface R2ObjectLike {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: unknown;
  readonly customMetadata?: unknown;
  readonly storageClass?: string;
  readonly range?: unknown;
  readonly checksums?: { toJSON?: () => unknown };
  readonly writeHttpMetadata: (headers: Headers) => void;
  readonly body?: ReadableStream;
  readonly arrayBuffer?: () => Promise<ArrayBuffer>;
}

const isR2ObjectLike = (value: unknown): value is R2ObjectLike =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as R2ObjectLike).key === "string" &&
  typeof (value as R2ObjectLike).etag === "string" &&
  typeof (value as R2ObjectLike).httpEtag === "string" &&
  typeof (value as R2ObjectLike).writeHttpMetadata === "function";

/** `R2Objects` — the container a `list` call returns. */
const isR2ObjectsLike = (
  value: unknown,
): value is {
  objects: Array<unknown>;
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: Array<string>;
} =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { objects?: unknown }).objects) &&
  typeof (value as { truncated?: unknown }).truncated === "boolean" &&
  Array.isArray((value as { delimitedPrefixes?: unknown }).delimitedPrefixes);

const encodeR2Object = (
  value: R2ObjectLike,
  body?: { base64: string },
): EncodedValue => {
  const fields: Record<string, EncodedValue> = {};
  const plain: Record<string, unknown> = {
    key: value.key,
    version: value.version,
    size: value.size,
    etag: value.etag,
    httpEtag: value.httpEtag,
    uploaded: value.uploaded,
    httpMetadata: value.httpMetadata,
    customMetadata: value.customMetadata,
    storageClass: value.storageClass,
    range: value.range,
    checksums: value.checksums?.toJSON?.(),
  };
  for (const [key, entry] of Object.entries(plain)) {
    if (entry === undefined) continue;
    fields[key] = encodeValue(entry, encodeWorkerValue);
  }
  return { $: "r2-object", fields, ...(body !== undefined ? { body } : {}) };
};

const decodeArg = async (
  env: Env,
  binding: string,
  arg: EncodedValue,
): Promise<unknown> => {
  if (arg.$ === "chain") {
    return evaluateChain(env, binding, arg.chain);
  }
  if (arg.$ === "durable-object-id") {
    const namespace = env[binding] as DurableObjectNamespace | undefined;
    if (typeof namespace?.idFromString !== "function") {
      throw new ProxyRequestError(
        `platform-proxy: binding "${binding}" cannot rehydrate a DurableObjectId (no idFromString).`,
      );
    }
    return namespace.idFromString(arg.id);
  }
  return decodeValue(arg);
};

const evaluateChain = async (
  env: Env,
  binding: string,
  chain: Array<EncodedChainSegment>,
): Promise<unknown> => {
  let target: unknown = env[binding];
  if (target === undefined) {
    throw new ProxyRequestError(
      `platform-proxy: binding "${binding}" not found`,
      404,
    );
  }
  let path = binding;
  for (const segment of chain) {
    const args = await Promise.all(
      segment.args.map((arg) => decodeArg(env, binding, arg)),
    );
    const method = (target as Record<string, unknown> | null)?.[segment.method];
    if (typeof method !== "function") {
      const targetObject = target as object | null;
      const available =
        targetObject === null
          ? []
          : [
              ...Object.getOwnPropertyNames(targetObject),
              ...Object.getOwnPropertyNames(
                Object.getPrototypeOf(targetObject) ?? {},
              ),
            ];
      throw new ProxyRequestError(
        `platform-proxy: "${segment.method}" is not a method on \`${path}\` ` +
          `(${(targetObject as { constructor?: { name?: string } })?.constructor?.name ?? typeof target}; available: ${available.join(", ")})`,
      );
    }
    // Reflect.apply (never `method.apply`): property access on workers RPC
    // method stubs turns "apply" into an RPC path segment instead of calling.
    target = await Reflect.apply(
      method as (...args: Array<unknown>) => unknown,
      target,
      args,
    );
    path += `.${segment.method}(…)`;
  }
  return target;
};

const resultHeaders = (kind: ResultKind, extra?: Record<string, string>) => ({
  [HEADER_RESULT]: kind,
  ...extra,
});

const encodeResult = async (result: unknown): Promise<Response> => {
  if (result instanceof ReadableStream) {
    return new Response(result, { headers: resultHeaders("stream") });
  }
  // R2 rich objects: a `get` result carries a one-shot body — buffer it
  // here (async) so the sync encoder can ship it; bodyless heads/lists
  // fall through to the generic path via `encodeWorkerValue`.
  if (
    isR2ObjectLike(result) &&
    result.body !== undefined &&
    result.arrayBuffer !== undefined
  ) {
    const bytes = new Uint8Array(await result.arrayBuffer());
    return Response.json(
      { value: encodeR2Object(result, { base64: bytesToBase64(bytes) }) },
      { headers: resultHeaders("json") },
    );
  }
  if (isR2ObjectsLike(result)) {
    // The container is itself a class instance — encode it field-wise.
    const encoded: Record<string, EncodedValue> = {
      objects: encodeValue(result.objects, encodeWorkerValue),
      truncated: encodeValue(result.truncated),
      delimitedPrefixes: encodeValue(result.delimitedPrefixes),
    };
    if (result.cursor !== undefined) {
      encoded.cursor = encodeValue(result.cursor);
    }
    return Response.json(
      { value: { $: "object", value: encoded } satisfies EncodedValue },
      { headers: resultHeaders("json") },
    );
  }
  if (result instanceof ArrayBuffer) {
    return new Response(result, {
      headers: resultHeaders("bytes", { [HEADER_BYTES_KIND]: "arraybuffer" }),
    });
  }
  if (ArrayBuffer.isView(result)) {
    const bytes = new Uint8Array(
      result.buffer,
      result.byteOffset,
      result.byteLength,
    );
    const kind =
      result instanceof Uint8Array ? "uint8array" : result.constructor.name;
    return new Response(bytes, {
      headers: resultHeaders("bytes", { [HEADER_BYTES_KIND]: kind }),
    });
  }
  return Response.json(
    { value: encodeValue(result, encodeWorkerValue) },
    { headers: resultHeaders("json") },
  );
};

const handleCall = async (
  request: WorkerRequest,
  env: Env,
): Promise<Response> => {
  const { binding, chain } = (await request.json()) as CallRequest;
  if (typeof binding !== "string" || !Array.isArray(chain)) {
    throw new ProxyRequestError("platform-proxy: malformed /call request body");
  }
  const result = await evaluateChain(env, binding, chain);
  return await encodeResult(result);
};

// ---------------------------------------------------------------------------
// Fetch passthrough
// ---------------------------------------------------------------------------

const handleProxyFetch = async (
  request: WorkerRequest,
  env: Env,
): Promise<Response> => {
  const binding = request.headers.get(HEADER_BINDING);
  const targetUrl = request.headers.get(HEADER_URL);
  if (!binding || !targetUrl) {
    throw new ProxyRequestError(
      "platform-proxy: missing binding or target url on /fetch request",
    );
  }
  const chainHeader = request.headers.get(HEADER_CHAIN);
  const chain: Array<EncodedChainSegment> = chainHeader
    ? (JSON.parse(
        decodeURIComponent(chainHeader),
      ) as Array<EncodedChainSegment>)
    : [];
  const target = (await evaluateChain(env, binding, chain)) as {
    fetch?: (request: Request) => Promise<Response>;
  } | null;
  if (typeof target?.fetch !== "function") {
    throw new ProxyRequestError(
      `platform-proxy: the resolved target on binding "${binding}" has no fetch() method`,
    );
  }
  const headers = new Headers(request.headers);
  for (const header of [
    HEADER_TOKEN,
    HEADER_BINDING,
    HEADER_CHAIN,
    HEADER_URL,
  ]) {
    headers.delete(header);
  }
  const forwarded = new Request(targetUrl, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  });
  return await target.fetch(forwarded);
};

// ---------------------------------------------------------------------------
// Cache emulation
//
// workerd's built-in Cache API is a no-op unless backed by an external cache
// service, so the proxy worker hosts its own in-memory store. Entries live for
// the lifetime of the workerd instance and follow the Workers cache rules that
// matter in dev: GET-only keys, no 206 responses, no `Vary: *`.
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly status: number;
  readonly headers: Array<[string, string]>;
  readonly body: Uint8Array;
}

const cacheStore = new Map<string, Map<string, CacheEntry>>();

const cacheKey = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
};

const getCacheContext = (request: WorkerRequest) => {
  const name = request.headers.get(HEADER_CACHE_NAME);
  const url = request.headers.get(HEADER_CACHE_URL);
  if (name === null || url === null) {
    throw new ProxyRequestError("platform-proxy: missing cache name or url");
  }
  const method = request.headers.get(HEADER_CACHE_METHOD) ?? "GET";
  const ignoreMethod =
    request.headers.get(HEADER_CACHE_IGNORE_METHOD) === "true";
  return { name, key: cacheKey(url), method: ignoreMethod ? "GET" : method };
};

const handleCacheMatch = (request: WorkerRequest): Response => {
  const { name, key, method } = getCacheContext(request);
  if (method !== "GET") return new Response(null, { status: 204 });
  const entry = cacheStore.get(name)?.get(key);
  if (entry === undefined) return new Response(null, { status: 204 });
  return new Response(entry.body, {
    status: 200,
    headers: {
      [HEADER_CACHE_STATUS]: entry.status.toString(),
      [HEADER_CACHE_HEADERS]: encodeURIComponent(JSON.stringify(entry.headers)),
    },
  });
};

const handleCachePut = async (request: WorkerRequest): Promise<Response> => {
  const { name, key, method } = getCacheContext(request);
  const status = parseInt(request.headers.get(HEADER_CACHE_STATUS) ?? "NaN");
  const rawHeaders = request.headers.get(HEADER_CACHE_HEADERS);
  if (Number.isNaN(status) || rawHeaders === null) {
    throw new ProxyRequestError("platform-proxy: malformed cache put request");
  }
  if (method !== "GET") {
    throw new ProxyRequestError("Cannot cache response to non-GET request.");
  }
  if (status === 206) {
    throw new ProxyRequestError(
      "Cannot cache response to a range request (206 Partial Content).",
    );
  }
  const headers = JSON.parse(decodeURIComponent(rawHeaders)) as Array<
    [string, string]
  >;
  const vary = headers.find(([header]) => header.toLowerCase() === "vary");
  if (vary && vary[1].includes("*")) {
    throw new ProxyRequestError("Cannot cache response with 'Vary: *' header.");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  let entries = cacheStore.get(name);
  if (entries === undefined) {
    entries = new Map();
    cacheStore.set(name, entries);
  }
  entries.set(key, { status, headers, body });
  return new Response(null, { status: 204 });
};

const handleCacheDelete = (request: WorkerRequest): Response => {
  const { name, key, method } = getCacheContext(request);
  const deleted =
    method === "GET" && (cacheStore.get(name)?.delete(key) ?? false);
  return Response.json(deleted);
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: WorkerRequest, env) {
    try {
      assertAuthorized(request, env);
      const url = new URL(request.url);
      switch (url.pathname) {
        case PATH_ENV:
          return Response.json(describeEnv(env));
        case PATH_CALL:
          return await handleCall(request, env);
        case PATH_FETCH:
          return await handleProxyFetch(request, env);
        case PATH_CACHE_MATCH:
          return handleCacheMatch(request);
        case PATH_CACHE_PUT:
          return await handleCachePut(request);
        case PATH_CACHE_DELETE:
          return handleCacheDelete(request);
        default:
          return Response.json(
            { error: `platform-proxy: unknown route ${url.pathname}` },
            { status: 404 },
          );
      }
    } catch (error) {
      const status = error instanceof ProxyRequestError ? error.status : 500;
      const encoded = encodeValue(
        error instanceof Error ? error : new Error(String(error)),
        encodeWorkerValue,
      );
      return Response.json(
        { error: encoded },
        { status, headers: { [HEADER_RESULT]: "error" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
