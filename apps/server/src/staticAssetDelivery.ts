// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import * as NodeUtil from "node:util";

/**
 * Delivery policy for the packaged web bundle. Vite emits content-hashed
 * files under `assets/`, so those are immutable and safe to cache forever,
 * while `index.html` and the SPA fallback must revalidate or a new build is
 * never picked up.
 */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";

/** Vite content hashes are at least 8 url-safe characters before the extension. */
const HASHED_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/**
 * Compressing tiny payloads costs more than it saves, and the header
 * overhead can make the response larger than the original.
 */
const MIN_COMPRESSIBLE_BYTES = 1024;

/** Total size of compressed payloads retained across all static files. */
const COMPRESSED_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const COMPRESSIBLE_CONTENT_TYPES = [
  "text/",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "application/wasm",
  "image/svg+xml",
];

const gzip = NodeUtil.promisify(NodeZlib.gzip);
const brotliCompress = NodeUtil.promisify(NodeZlib.brotliCompress);

export type StaticContentEncoding = "br" | "gzip";

export function resolveStaticCacheControl(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.startsWith("assets/") && HASHED_ASSET_PATTERN.test(normalized)
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL;
}

/**
 * Cache key derived from the bytes being served rather than from file
 * metadata. Used where the served content and the metadata could otherwise
 * disagree, which would let one request's compression be reused for
 * different content. Only worth it for small payloads, since it hashes the
 * whole buffer on every request.
 */
export function contentCacheKey(data: Uint8Array): string {
  return NodeCrypto.createHash("sha1").update(data).digest("hex");
}

export function isCompressibleContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return COMPRESSIBLE_CONTENT_TYPES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Pick an encoding from `Accept-Encoding`, preferring Brotli. Entries with an
 * explicit `q=0` are refusals, and `identity;q=0` plus an unsupported codec
 * list leaves nothing usable, so the caller falls back to the raw bytes.
 */
export function negotiateStaticEncoding(
  acceptEncoding: string | undefined,
): StaticContentEncoding | null {
  if (!acceptEncoding) return null;

  const acceptedQualityByCodec = new Map<string, number>();
  for (const entry of acceptEncoding.split(",")) {
    const [rawCodec = "", ...parameters] = entry.trim().split(";");
    const codec = rawCodec.trim().toLowerCase();
    if (!codec) continue;
    const quality = parameters
      .map((parameter) => /^\s*q=([0-9.]+)\s*$/i.exec(parameter))
      .find((match) => match !== null)?.[1];
    acceptedQualityByCodec.set(codec, quality === undefined ? 1 : Number.parseFloat(quality));
  }

  const accepts = (codec: StaticContentEncoding) => {
    const quality = acceptedQualityByCodec.get(codec) ?? acceptedQualityByCodec.get("*");
    return quality !== undefined && quality > 0;
  };

  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return null;
}

async function compressBytes(
  data: Uint8Array,
  encoding: StaticContentEncoding,
): Promise<Uint8Array> {
  if (encoding === "gzip") {
    return new Uint8Array(await gzip(data));
  }
  return new Uint8Array(
    await brotliCompress(data, {
      params: {
        // Default quality 11 costs seconds on a multi-megabyte bundle. 5 is
        // the usual static-asset sweet spot, and every result is cached.
        [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [NodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
      },
    }),
  );
}

/**
 * Compress once per (file, encoding) and reuse the result. Packaged assets
 * never change while the server runs, so recompressing a multi-megabyte
 * bundle for every remote request is pure waste. Entries are keyed by mtime
 * and size so a dev-server rebuild is not served stale.
 */
export function makeStaticCompressionCache(compress = compressBytes) {
  const compressedByKey = new Map<string, Uint8Array>();
  /**
   * Compressions already running. A cold start requests the bundle, its CSS,
   * and its chunks at once, and browsers retry, so without this the same
   * multi-megabyte payload is compressed once per concurrent request.
   */
  const inFlightByKey = new Map<string, Promise<Uint8Array | null>>();
  let retainedBytes = 0;

  const evictOldest = (incomingBytes: number) => {
    while (retainedBytes + incomingBytes > COMPRESSED_CACHE_MAX_BYTES) {
      const oldestKey = compressedByKey.keys().next().value;
      if (oldestKey === undefined) return;
      retainedBytes -= compressedByKey.get(oldestKey)?.byteLength ?? 0;
      compressedByKey.delete(oldestKey);
    }
  };

  const compressAndRetain = async (
    key: string,
    data: Uint8Array,
    encoding: StaticContentEncoding,
  ): Promise<Uint8Array | null> => {
    const compressed = await compress(data, encoding);
    // A payload that grew under compression is not worth serving encoded.
    if (compressed.byteLength >= data.byteLength) return null;

    if (compressed.byteLength <= COMPRESSED_CACHE_MAX_BYTES) {
      evictOldest(compressed.byteLength);
      compressedByKey.set(key, compressed);
      retainedBytes += compressed.byteLength;
    }
    return compressed;
  };

  return {
    get(input: {
      readonly cacheKey: string;
      readonly data: Uint8Array;
      readonly encoding: StaticContentEncoding;
    }): Promise<Uint8Array | null> {
      if (input.data.byteLength < MIN_COMPRESSIBLE_BYTES) return Promise.resolve(null);

      const key = `${input.encoding} ${input.cacheKey}`;
      const cached = compressedByKey.get(key);
      if (cached) return Promise.resolve(cached);

      const pending = inFlightByKey.get(key);
      if (pending) return pending;

      // Clear the in-flight entry however this settles, so a failed
      // compression is retried rather than remembered as permanently pending.
      const compression = compressAndRetain(key, input.data, input.encoding).finally(() => {
        inFlightByKey.delete(key);
      });
      inFlightByKey.set(key, compression);
      return compression;
    },
    get retainedByteLength(): number {
      return retainedBytes;
    },
  };
}

export type StaticCompressionCache = ReturnType<typeof makeStaticCompressionCache>;
