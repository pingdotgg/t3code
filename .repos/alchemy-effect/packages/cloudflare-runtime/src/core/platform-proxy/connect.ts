/**
 * Runtime-free platform-proxy client: {@link connect} reconstructs the
 * Node-side proxies (`env`, `cf`, `ctx`, `caches`) of an ALREADY-RUNNING
 * platform proxy from its {@link ConnectInfo} — two plain strings
 * (`{ url, token }`, exposed on `PlatformProxyInstance.connectInfo` by
 * {@link ./PlatformProxy.ts | PlatformProxy.open} / `getPlatformProxy`).
 *
 * This module has no Effect / Runtime / Scope imports (only the shared
 * protocol codec), so it is safe to load anywhere a URL can reach the proxy:
 * framework dev-server worker threads (e.g. nitro's dev SSR worker), child
 * processes, or any plain Node script. Because the entire client state is
 * the two strings, connect info survives serialization boundaries
 * (`runtimeConfig`, env vars, IPC) and every client shares the SAME live
 * binding state hosted by the proxy's workerd instance.
 *
 * The proxies come with the limitations documented on
 * {@link ./PlatformProxy.ts} (no sync id materialisation, JSON-compatible
 * results + bytes/streams only, no `connect()` on sockets). The instance's
 * lifetime belongs to whoever opened it: once it is disposed, {@link connect}
 * and every proxied call fail fast with a descriptive error.
 */
import type {
  CallRequest,
  EncodedChainSegment,
  EncodedValue,
  EnvDescriptor,
} from "./PlatformProxyProtocol.shared.ts";
import {
  base64ToBytes,
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Everything a client needs to (re)connect to a running platform proxy.
 * Plain strings by design: connect info can cross any serialization boundary
 * (worker threads, `runtimeConfig`, env vars) and still reconstruct the full
 * proxied environment with {@link connect}.
 */
export interface ConnectInfo {
  /** Base URL of the proxy workerd instance. */
  readonly url: string;
  /** The instance's auth token (every proxy endpoint 401s without it). */
  readonly token: string;
}

/** The Node-side proxies {@link connect} builds from a {@link ConnectInfo}. */
export interface ConnectedPlatformProxy<Env = Record<string, unknown>> {
  /** Environment object containing the instance's bindings. */
  readonly env: Env;
  /** Mock of the `request.cf` object (deep-frozen). */
  readonly cf: CfProperties;
  /** Mock of the Workers `ExecutionContext`; all methods are no-ops. */
  readonly ctx: ExecutionContext;
  /** Cache API proxy backed by the workerd instance. */
  readonly caches: PlatformProxyCacheStorage;
}

export type CfProperties = Record<string, unknown>;

export interface PlatformProxyCacheStorage {
  readonly default: PlatformProxyCache;
  readonly open: (cacheName: string) => Promise<PlatformProxyCache>;
}

export interface PlatformProxyCache {
  readonly match: (
    request: CacheRequestLike,
    options?: CacheQueryOptions,
  ) => Promise<Response | undefined>;
  readonly put: (
    request: CacheRequestLike,
    response: CacheResponseLike,
  ) => Promise<void>;
  readonly delete: (
    request: CacheRequestLike,
    options?: CacheQueryOptions,
  ) => Promise<boolean>;
}

export type CacheRequestLike = string | URL | { url: string; method?: string };

export interface CacheResponseLike {
  readonly status: number;
  readonly headers: Iterable<[string, string]>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface CacheQueryOptions {
  readonly ignoreMethod?: boolean;
}

/**
 * Mock of the `ExecutionContext` Workers hand to their request handlers.
 * All methods are no-ops; detached invocation throws "Illegal invocation",
 * matching both the runtime and wrangler's `getPlatformProxy`.
 */
export class ExecutionContext {
  waitUntil(_promise: Promise<unknown>): void {
    if (!(this instanceof ExecutionContext)) {
      throw new Error("Illegal invocation");
    }
  }
  passThroughOnException(): void {
    if (!(this instanceof ExecutionContext)) {
      throw new Error("Illegal invocation");
    }
  }
  props: Record<string, unknown> = {};
}

// ---------------------------------------------------------------------------
// Proxy client
// ---------------------------------------------------------------------------

interface ProxyClient {
  readonly url: string | URL;
  readonly token: string;
}

interface ChainSegment {
  readonly method: string;
  readonly args: Array<unknown>;
}

interface ChainRef {
  readonly binding: string;
  readonly chain: Array<ChainSegment>;
}

const CHAIN = Symbol.for("cloudflare-runtime/platform-proxy/chain");
const DURABLE_OBJECT_ID = Symbol.for(
  "cloudflare-runtime/platform-proxy/durable-object-id",
);

interface MaterializedDurableObjectId {
  readonly [DURABLE_OBJECT_ID]: true;
  readonly name: string | undefined;
  readonly toString: () => string;
  readonly equals: (other: unknown) => boolean;
}

const makeDurableObjectId = (
  id: string,
  name?: string,
): MaterializedDurableObjectId => ({
  [DURABLE_OBJECT_ID]: true,
  name,
  toString: () => id,
  equals: (other: unknown) => String(other) === id,
});

const getChainRef = (value: unknown): ChainRef | undefined =>
  typeof value === "function" || (typeof value === "object" && value !== null)
    ? ((value as Record<PropertyKey, unknown>)[CHAIN] as ChainRef | undefined)
    : undefined;

const isMaterializedId = (
  value: unknown,
): value is MaterializedDurableObjectId =>
  typeof value === "object" && value !== null && DURABLE_OBJECT_ID in value;

const encodeNodeValue = (value: unknown): EncodedValue | undefined => {
  if (isMaterializedId(value)) {
    const name = value.name;
    return {
      $: "durable-object-id",
      id: value.toString(),
      ...(name !== undefined ? { name } : {}),
    };
  }
  return undefined;
};

const encodeArg = (binding: string, value: unknown): EncodedValue => {
  const ref = getChainRef(value);
  if (ref !== undefined) {
    if (ref.binding !== binding) {
      throw new Error(
        `platform-proxy: cannot pass a stub of binding "${ref.binding}" to a call on binding "${binding}". ` +
          "Cross-binding stub arguments are not supported.",
      );
    }
    return { $: "chain", chain: encodeChain(binding, ref.chain) };
  }
  return encodeValue(value, encodeNodeValue);
};

const encodeChain = (
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): Array<EncodedChainSegment> =>
  chain.map((segment) => ({
    method: segment.method,
    args: segment.args.map((arg) => encodeArg(binding, arg)),
  }));

const decodeNodeValue = (
  encoded: EncodedValue,
): { readonly value: unknown } | undefined => {
  if (encoded.$ === "durable-object-id") {
    return { value: makeDurableObjectId(encoded.id, encoded.name) };
  }
  if (encoded.$ === "r2-object") {
    return { value: decodeR2Object(encoded) };
  }
  return undefined;
};

/**
 * Rehydrate an `R2Object` / `R2ObjectBody`: the plain fields plus, when the
 * worker captured a `get` result's content, a body stream and the buffering
 * accessors (`arrayBuffer`/`bytes`/`text`/`json`/`blob`). `writeHttpMetadata`
 * mirrors the native behavior over the decoded `httpMetadata`.
 */
const decodeR2Object = (
  encoded: Extract<EncodedValue, { $: "r2-object" }>,
): unknown => {
  const fields = decodeValue(
    { $: "object", value: encoded.fields },
    decodeNodeValue,
  ) as Record<string, unknown>;
  const httpMetadata = (fields.httpMetadata ?? {}) as Record<string, unknown>;
  const object: Record<string, unknown> = {
    checksums: {},
    ...fields,
    writeHttpMetadata: (headers: Headers) => {
      const set = (name: string, value: unknown) => {
        if (typeof value === "string") headers.set(name, value);
      };
      set("content-type", httpMetadata.contentType);
      set("content-language", httpMetadata.contentLanguage);
      set("content-disposition", httpMetadata.contentDisposition);
      set("content-encoding", httpMetadata.contentEncoding);
      set("cache-control", httpMetadata.cacheControl);
      if (httpMetadata.cacheExpiry instanceof Date) {
        headers.set("expires", httpMetadata.cacheExpiry.toUTCString());
      }
    },
  };
  if (encoded.body !== undefined) {
    const bytes = base64ToBytes(encoded.body.base64);
    let bodyUsed = false;
    const consume = <T>(f: () => T): T => {
      bodyUsed = true;
      return f();
    };
    Object.defineProperties(object, {
      bodyUsed: { get: () => bodyUsed, enumerable: true },
      body: {
        get: () => consume(() => new Response(copyBytes(bytes)).body),
        enumerable: true,
      },
    });
    object.arrayBuffer = () =>
      Promise.resolve(consume(() => copyBytes(bytes).buffer));
    object.bytes = () => Promise.resolve(consume(() => copyBytes(bytes)));
    object.text = () =>
      Promise.resolve(consume(() => new TextDecoder().decode(bytes)));
    object.json = () =>
      Promise.resolve(
        consume(() => JSON.parse(new TextDecoder().decode(bytes))),
      );
    object.blob = () =>
      Promise.resolve(consume(() => new Blob([copyBytes(bytes)])));
  }
  return object;
};

const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy as Uint8Array<ArrayBuffer>;
};

const decodeCallError = async (response: Response): Promise<Error> => {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: EncodedValue }
    | undefined;
  if (body?.error !== undefined) {
    const decoded = decodeValue(body.error, decodeNodeValue);
    if (decoded instanceof Error) return decoded;
    return new Error(String(decoded));
  }
  return new Error(
    `platform-proxy: request failed with status ${response.status}`,
  );
};

const callBinding = async (
  client: ProxyClient,
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): Promise<unknown> => {
  const request: CallRequest = { binding, chain: encodeChain(binding, chain) };
  const response = await fetch(new URL(PATH_CALL, client.url), {
    method: "POST",
    headers: {
      [HEADER_TOKEN]: client.token,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const kind = response.headers.get(HEADER_RESULT);
  switch (kind) {
    case "json": {
      const { value } = (await response.json()) as { value: EncodedValue };
      return decodeValue(value, decodeNodeValue);
    }
    case "bytes": {
      const buffer = await response.arrayBuffer();
      return response.headers.get(HEADER_BYTES_KIND) === "arraybuffer"
        ? buffer
        : new Uint8Array(buffer);
    }
    case "stream":
      return response.body;
    case "error":
      throw await decodeCallError(response);
    default:
      throw new Error(
        `platform-proxy: unexpected response (${response.status}) from the proxy worker`,
      );
  }
};

const passthroughFetch = async (
  client: ProxyClient,
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const request =
    typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
        ? new Request(input.toString(), init)
        : new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set(HEADER_TOKEN, client.token);
  headers.set(HEADER_BINDING, binding);
  headers.set(HEADER_URL, request.url);
  if (chain.length > 0) {
    headers.set(
      HEADER_CHAIN,
      encodeURIComponent(JSON.stringify(encodeChain(binding, chain))),
    );
  }
  return await fetch(new URL(PATH_FETCH, client.url), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    // Required by undici when forwarding a streaming body.
    ...(request.body !== null ? { duplex: "half" } : {}),
  } as RequestInit);
};

const stubDescription = (
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): string =>
  `[platform-proxy stub ${binding}${chain.map((segment) => `.${segment.method}(…)`).join("")}]`;

/**
 * A lazy expression-tree proxy: property accesses build up a method chain,
 * awaiting the proxy sends the whole chain to the worker in one request.
 */
const makeStub = (
  client: ProxyClient,
  binding: string,
  chain: Array<ChainSegment>,
): unknown => {
  let memo: Promise<unknown> | undefined;
  const run = () => (memo ??= callBinding(client, binding, chain));
  // A plain-object target: `typeof stub` must not be "function", otherwise
  // consumers (and test matchers) treat awaited stubs as callables.
  const target: Record<PropertyKey, unknown> = {
    [CHAIN]: { binding, chain } satisfies ChainRef,
  };
  return new Proxy(target, {
    get(object, property) {
      if (property === CHAIN) return object[CHAIN];
      if (property === "then") {
        // The binding root itself is not thenable; call results are.
        if (chain.length === 0) return undefined;
        const promise = run();
        return promise.then.bind(promise);
      }
      if (
        chain.length > 0 &&
        (property === "catch" || property === "finally")
      ) {
        const promise = run();
        return (promise[property] as (...args: Array<unknown>) => unknown).bind(
          promise,
        );
      }
      if (property === "fetch") {
        return (input: string | URL | Request, init?: RequestInit) =>
          passthroughFetch(client, binding, chain, input, init);
      }
      if (property === "connect") {
        return () => {
          throw new Error(
            "platform-proxy: connect() is not supported over the platform proxy.",
          );
        };
      }
      if (property === "toString" || property === Symbol.toPrimitive) {
        return () => stubDescription(binding, chain);
      }
      if (typeof property !== "string" || property === "toJSON") {
        return undefined;
      }
      return (...args: Array<unknown>) =>
        makeStub(client, binding, [...chain, { method: property, args }]);
    },
  });
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const normalizeCacheRequest = (
  request: CacheRequestLike,
): { url: string; method: string } => {
  if (typeof request === "string") return { url: request, method: "GET" };
  if (request instanceof URL) return { url: request.toString(), method: "GET" };
  return { url: request.url, method: request.method ?? "GET" };
};

const makeCache = (
  client: ProxyClient,
  cacheName: string,
): PlatformProxyCache => {
  const baseHeaders = (
    request: CacheRequestLike,
    options?: CacheQueryOptions,
  ) => {
    const { url, method } = normalizeCacheRequest(request);
    return {
      [HEADER_TOKEN]: client.token,
      [HEADER_CACHE_NAME]: cacheName,
      [HEADER_CACHE_URL]: url,
      [HEADER_CACHE_METHOD]: method,
      [HEADER_CACHE_IGNORE_METHOD]:
        options?.ignoreMethod === true ? "true" : "false",
    };
  };
  const rethrow = async (response: Response): Promise<never> => {
    throw await decodeCallError(response);
  };
  return {
    match: async (request, options) => {
      const response = await fetch(new URL(PATH_CACHE_MATCH, client.url), {
        method: "POST",
        headers: baseHeaders(request, options),
      });
      if (response.status === 204) return undefined;
      if (!response.ok) return rethrow(response);
      const status = parseInt(
        response.headers.get(HEADER_CACHE_STATUS) ?? "200",
      );
      const headers = new Headers(
        JSON.parse(
          decodeURIComponent(
            response.headers.get(HEADER_CACHE_HEADERS) ?? "%5B%5D",
          ),
        ) as Array<[string, string]>,
      );
      headers.set("cf-cache-status", "HIT");
      return new Response(await response.arrayBuffer(), { status, headers });
    },
    put: async (request, response) => {
      const body = await response.arrayBuffer();
      const result = await fetch(new URL(PATH_CACHE_PUT, client.url), {
        method: "POST",
        headers: {
          ...baseHeaders(request),
          [HEADER_CACHE_STATUS]: response.status.toString(),
          [HEADER_CACHE_HEADERS]: encodeURIComponent(
            JSON.stringify([...response.headers]),
          ),
        },
        body,
      });
      if (!result.ok) return rethrow(result);
    },
    delete: async (request, options) => {
      const response = await fetch(new URL(PATH_CACHE_DELETE, client.url), {
        method: "POST",
        headers: baseHeaders(request, options),
      });
      if (!response.ok) return rethrow(response);
      return (await response.json()) as boolean;
    },
  };
};

const makeCacheStorage = (client: ProxyClient): PlatformProxyCacheStorage => {
  const defaultCache = makeCache(client, "default");
  return {
    default: defaultCache,
    open: (cacheName: string) => {
      if (cacheName === "default") {
        return Promise.reject(
          new TypeError(
            '"default" is a reserved cache name. Use `caches.default` instead.',
          ),
        );
      }
      return Promise.resolve(makeCache(client, `named:${cacheName}`));
    },
  };
};

// ---------------------------------------------------------------------------
// cf mock
// ---------------------------------------------------------------------------

const deepFreeze = (value: Record<string, unknown>): void => {
  Object.freeze(value);
  for (const property of Object.values(value)) {
    if (
      property !== null &&
      typeof property === "object" &&
      !Object.isFrozen(property)
    ) {
      deepFreeze(property as Record<string, unknown>);
    }
  }
};

/**
 * Static mock of `request.cf`, mirroring the fallback object miniflare uses
 * when it cannot fetch real values.
 */
const makeCf = (): CfProperties => {
  const cf: CfProperties = {
    asOrganization: "",
    asn: 395747,
    colo: "DFW",
    city: "Austin",
    region: "Texas",
    regionCode: "TX",
    metroCode: "635",
    postalCode: "78701",
    country: "US",
    continent: "NA",
    timezone: "America/Chicago",
    latitude: "30.27130",
    longitude: "-97.74260",
    clientTcpRtt: 0,
    httpProtocol: "HTTP/1.1",
    requestPriority: "weight=192;exclusive=0",
    tlsCipher: "AEAD-AES128-GCM-SHA256",
    tlsVersion: "TLSv1.3",
    tlsClientAuth: {
      certPresented: "0",
      certVerified: "NONE",
      certRevoked: "0",
      certIssuerDN: "",
      certSubjectDN: "",
      certIssuerDNRFC2253: "",
      certSubjectDNRFC2253: "",
      certIssuerDNLegacy: "",
      certSubjectDNLegacy: "",
      certSerial: "",
      certIssuerSerial: "",
      certSKI: "",
      certIssuerSKI: "",
      certFingerprintSHA1: "",
      certFingerprintSHA256: "",
      certNotBefore: "",
      certNotAfter: "",
    },
    edgeRequestKeepAliveStatus: 0,
    hostMetadata: undefined,
    clientTrustScore: 99,
    botManagement: {
      corporateProxy: false,
      verifiedBot: false,
      ja3Hash: "25b4882c2bcb50cd6b469ff28c596742",
      staticResource: false,
      detectionIds: [],
      score: 99,
    },
  };
  deepFreeze(cf);
  return cf;
};

// ---------------------------------------------------------------------------
// Env construction
// ---------------------------------------------------------------------------

const fetchEnvDescriptor = async (
  client: ProxyClient,
): Promise<EnvDescriptor> => {
  let response: Response;
  try {
    response = await fetch(new URL(PATH_ENV, client.url), {
      headers: { [HEADER_TOKEN]: client.token },
    });
  } catch (cause) {
    throw new Error(
      `platform-proxy: could not reach the proxy worker at ${client.url} — ` +
        "the instance may have been disposed or restarted.",
      { cause },
    );
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => {});
    throw new Error(
      `platform-proxy: /env request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as EnvDescriptor;
};

const buildEnv = (
  client: ProxyClient,
  descriptor: EnvDescriptor,
): Record<string, unknown> => {
  const env: Record<string, unknown> = {};
  for (const binding of descriptor.bindings) {
    env[binding.name] =
      binding.kind === "value"
        ? decodeValue(binding.value, decodeNodeValue)
        : makeStub(client, binding.name, []);
  }
  return env;
};

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

/**
 * Build the Node-side proxies (`env`, `cf`, `ctx`, `caches`) for a running
 * platform proxy from its `{ url, token }` connect info.
 *
 * ```ts
 * // process A (owns the instance's lifetime)
 * const proxy = await getPlatformProxy({ bindings: [...] });
 * send(proxy.connectInfo); // two plain strings
 *
 * // process/thread B — binding state is SHARED with process A
 * const { env, cf, ctx, caches } = await connect(received);
 * await env.KV.get("key");
 * ```
 *
 * Fails fast with a descriptive error when the proxy is unreachable (the
 * owning instance was disposed or restarted).
 */
export const connect = async <Env = Record<string, unknown>>(
  info: ConnectInfo,
): Promise<ConnectedPlatformProxy<Env>> => {
  const client: ProxyClient = { url: info.url, token: info.token };
  const descriptor = await fetchEnvDescriptor(client);
  return {
    env: buildEnv(client, descriptor) as Env,
    cf: makeCf(),
    ctx: new ExecutionContext(),
    caches: makeCacheStorage(client),
  };
};
