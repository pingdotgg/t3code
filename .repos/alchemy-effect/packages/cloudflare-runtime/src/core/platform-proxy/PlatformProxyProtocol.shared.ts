/**
 * Wire protocol shared between the Node-side platform proxy client
 * ({@link ../platform-proxy/PlatformProxy.ts}) and the in-workerd proxy worker
 * ({@link ./PlatformProxy.worker.ts}).
 *
 * The protocol is a deliberately small "magic proxy" (in the spirit of
 * Miniflare's proxy client, reimplemented on our runtime):
 *
 * - `GET  /cdn-cgi/platform-proxy/env` — describe the worker's `env`:
 *   plain values are serialised inline, everything else is a stub.
 * - `POST /cdn-cgi/platform-proxy/call` — evaluate a method chain against a
 *   binding (e.g. `KV.get("key")`, `DO.get(DO.idFromName("a")).increment()`)
 *   and serialise the final result back.
 * - `*    /cdn-cgi/platform-proxy/fetch` — raw HTTP passthrough to a
 *   `fetch`-capable target (service bindings, Durable Object stubs) so
 *   request/response bodies stream natively.
 * - `POST /cdn-cgi/platform-proxy/cache/{match|put|delete}` — a small
 *   in-memory Cache API emulation hosted by the proxy worker.
 *
 * Values crossing the boundary use the fully-tagged {@link EncodedValue}
 * encoding: unambiguous, JSON-transportable, and easy to extend.
 */

export const PLATFORM_PROXY_PREFIX = "/cdn-cgi/platform-proxy";
export const PATH_ENV = `${PLATFORM_PROXY_PREFIX}/env`;
export const PATH_CALL = `${PLATFORM_PROXY_PREFIX}/call`;
export const PATH_FETCH = `${PLATFORM_PROXY_PREFIX}/fetch`;
export const PATH_CACHE_MATCH = `${PLATFORM_PROXY_PREFIX}/cache/match`;
export const PATH_CACHE_PUT = `${PLATFORM_PROXY_PREFIX}/cache/put`;
export const PATH_CACHE_DELETE = `${PLATFORM_PROXY_PREFIX}/cache/delete`;

/** Text binding carrying the per-instance auth token into the proxy worker. */
export const BINDING_PLATFORM_PROXY_TOKEN = "__PLATFORM_PROXY_TOKEN__";

export const HEADER_TOKEN = "x-platform-proxy-token";
export const HEADER_BINDING = "x-platform-proxy-binding";
export const HEADER_CHAIN = "x-platform-proxy-chain";
export const HEADER_URL = "x-platform-proxy-url";
export const HEADER_RESULT = "x-platform-proxy-result";
export const HEADER_BYTES_KIND = "x-platform-proxy-bytes-kind";
export const HEADER_CACHE_NAME = "x-platform-proxy-cache-name";
export const HEADER_CACHE_URL = "x-platform-proxy-cache-url";
export const HEADER_CACHE_METHOD = "x-platform-proxy-cache-method";
export const HEADER_CACHE_IGNORE_METHOD =
  "x-platform-proxy-cache-ignore-method";
export const HEADER_CACHE_STATUS = "x-platform-proxy-cache-status";
export const HEADER_CACHE_HEADERS = "x-platform-proxy-cache-headers";

/** `HEADER_RESULT` values for `/call` responses. */
export type ResultKind = "json" | "bytes" | "stream" | "error";

export type EncodedValue =
  | { readonly $: "undefined" }
  | { readonly $: "null" }
  | { readonly $: "boolean"; readonly value: boolean }
  | {
      readonly $: "number";
      readonly value: number | "NaN" | "Infinity" | "-Infinity";
    }
  | { readonly $: "bigint"; readonly value: string }
  | { readonly $: "string"; readonly value: string }
  | { readonly $: "date"; readonly value: number }
  | { readonly $: "bytes"; readonly kind: BytesKind; readonly base64: string }
  | { readonly $: "array"; readonly value: Array<EncodedValue> }
  | { readonly $: "object"; readonly value: Record<string, EncodedValue> }
  | {
      readonly $: "error";
      readonly name: string;
      readonly message: string;
      readonly stack?: string;
    }
  | {
      readonly $: "durable-object-id";
      readonly id: string;
      readonly name?: string;
    }
  | { readonly $: "chain"; readonly chain: Array<EncodedChainSegment> }
  /**
   * An `R2Object` / `R2ObjectBody` (rich class instances the generic object
   * rules reject). Fields are the plain data properties (key, etag, size,
   * uploaded, httpMetadata, …); `body` carries a `get` result's content so
   * the Node side can rehydrate the body stream and its buffering
   * accessors.
   */
  | {
      readonly $: "r2-object";
      readonly fields: Record<string, EncodedValue>;
      readonly body?: { readonly base64: string };
    };

export type BytesKind = "arraybuffer" | "uint8array" | string;

export interface EncodedChainSegment {
  readonly method: string;
  readonly args: Array<EncodedValue>;
}

export interface CallRequest {
  readonly binding: string;
  readonly chain: Array<EncodedChainSegment>;
}

export interface EnvDescriptor {
  readonly bindings: Array<EnvBindingDescriptor>;
}

export type EnvBindingDescriptor =
  | {
      readonly name: string;
      readonly kind: "value";
      readonly value: EncodedValue;
    }
  | {
      readonly name: string;
      readonly kind: "stub";
      readonly className?: string;
    };

export class UnsupportedValueError extends Error {
  override readonly name = "UnsupportedValueError";
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x2000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const describeValue = (value: unknown): string => {
  if (value === null || typeof value !== "object") return typeof value;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name && name !== "Object" ? name : "object";
};

/**
 * Encode a value into the tagged wire format. `encodeUnknown` lets each side
 * contribute environment-specific encodings (native `DurableObjectId` in the
 * worker, materialised ids and pending stub chains on the Node side) before
 * the generic rules run.
 */
export const encodeValue = (
  value: unknown,
  encodeUnknown?: (value: unknown) => EncodedValue | undefined,
): EncodedValue => {
  const custom = encodeUnknown?.(value);
  if (custom !== undefined) return custom;
  if (value === undefined) return { $: "undefined" };
  if (value === null) return { $: "null" };
  switch (typeof value) {
    case "boolean":
      return { $: "boolean", value };
    case "number":
      if (Number.isNaN(value)) return { $: "number", value: "NaN" };
      if (value === Infinity) return { $: "number", value: "Infinity" };
      if (value === -Infinity) return { $: "number", value: "-Infinity" };
      return { $: "number", value };
    case "bigint":
      return { $: "bigint", value: value.toString() };
    case "string":
      return { $: "string", value };
    default:
      break;
  }
  if (value instanceof Date) {
    return { $: "date", value: value.getTime() };
  }
  if (value instanceof ArrayBuffer) {
    return {
      $: "bytes",
      kind: "arraybuffer",
      base64: bytesToBase64(new Uint8Array(value)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    const kind =
      value instanceof Uint8Array ? "uint8array" : value.constructor.name;
    return { $: "bytes", kind, base64: bytesToBase64(bytes) };
  }
  if (value instanceof Error) {
    return {
      $: "error",
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return {
      $: "array",
      value: value.map((entry) => encodeValue(entry, encodeUnknown)),
    };
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const encoded: Record<string, EncodedValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        encoded[key] = encodeValue(entry, encodeUnknown);
      }
      return { $: "object", value: encoded };
    }
  }
  throw new UnsupportedValueError(
    `platform-proxy: cannot serialize a value of type "${describeValue(value)}" across the proxy boundary. ` +
      "Only JSON-compatible values, bytes, dates, errors, and DurableObjectIds are supported. " +
      "If you awaited an intermediate stub (e.g. a Durable Object stub), call a method on it instead of awaiting it.",
  );
};

/**
 * Decode a tagged wire value. `decodeUnknown` handles the environment-specific
 * tags (`durable-object-id`, `chain`) and takes precedence over the generic
 * rules; the generic decoder throws if one of those tags reaches it unhandled.
 */
export const decodeValue = (
  encoded: EncodedValue,
  decodeUnknown?: (
    encoded: EncodedValue,
  ) => { readonly value: unknown } | undefined,
): unknown => {
  const custom = decodeUnknown?.(encoded);
  if (custom !== undefined) return custom.value;
  switch (encoded.$) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
    case "string":
      return encoded.value;
    case "number":
      if (encoded.value === "NaN") return NaN;
      if (encoded.value === "Infinity") return Infinity;
      if (encoded.value === "-Infinity") return -Infinity;
      return encoded.value;
    case "bigint":
      return BigInt(encoded.value);
    case "date":
      return new Date(encoded.value);
    case "bytes": {
      const bytes = base64ToBytes(encoded.base64);
      if (encoded.kind === "arraybuffer") {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      }
      return bytes;
    }
    case "array":
      return encoded.value.map((entry) => decodeValue(entry, decodeUnknown));
    case "object": {
      const decoded: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(encoded.value)) {
        decoded[key] = decodeValue(entry, decodeUnknown);
      }
      return decoded;
    }
    case "error": {
      const error = new Error(encoded.message);
      error.name = encoded.name;
      if (encoded.stack !== undefined) error.stack = encoded.stack;
      return error;
    }
    case "durable-object-id":
    case "chain":
    case "r2-object":
      throw new UnsupportedValueError(
        `platform-proxy: unexpected "${encoded.$}" value in this context.`,
      );
  }
};
