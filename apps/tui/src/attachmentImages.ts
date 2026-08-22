// @effect-diagnostics globalFetch:off
import { decodeImage, type ImagePreview } from "@t3tools/opentui-image";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

const DEFAULT_CACHE_ENTRIES = 24;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const PREVIEW_MAX_WIDTH = 720;
const PREVIEW_MAX_HEIGHT = 480;

export interface AttachmentImageCache {
  readonly load: (attachmentId: string, url: string) => Promise<ImagePreview | null>;
  readonly clear: () => void;
}

export interface AttachmentImageCacheOptions {
  readonly fetcher?: (url: string, signal: AbortSignal) => Promise<Response>;
  readonly decoder?: (encoded: Uint8Array) => Promise<ImagePreview>;
  readonly maxEntries?: number;
  readonly maxEncodedBytes?: number;
  readonly fetchTimeoutMs?: number;
}

export function createAttachmentImageCache(
  options: AttachmentImageCacheOptions = {},
): AttachmentImageCache {
  const fetcher =
    options.fetcher ?? ((url: string, signal: AbortSignal) => globalThis.fetch(url, { signal }));
  const decoder =
    options.decoder ??
    ((encoded: Uint8Array) =>
      decodeImage(encoded, { maxWidth: PREVIEW_MAX_WIDTH, maxHeight: PREVIEW_MAX_HEIGHT }));
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
  const maxEncodedBytes = options.maxEncodedBytes ?? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  assertPositiveInteger(maxEntries, "maxEntries");
  assertPositiveInteger(maxEncodedBytes, "maxEncodedBytes");
  assertPositiveInteger(fetchTimeoutMs, "fetchTimeoutMs");
  const cache = new Map<string, Promise<ImagePreview | null>>();

  const load = (attachmentId: string, url: string): Promise<ImagePreview | null> => {
    const existing = cache.get(attachmentId);
    if (existing) {
      cache.delete(attachmentId);
      cache.set(attachmentId, existing);
      return existing;
    }

    const pending = (async () => {
      try {
        const response = await fetcher(url, AbortSignal.timeout(fetchTimeoutMs));
        if (!response.ok) return null;
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > maxEncodedBytes) return null;
        const encoded = await readResponseBytes(response, maxEncodedBytes);
        if (!encoded) return null;
        return await decoder(encoded);
      } catch {
        return null;
      }
    })();
    cache.set(attachmentId, pending);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    void pending.then((image) => {
      if (image === null && cache.get(attachmentId) === pending) cache.delete(attachmentId);
    });
    return pending;
  };

  return {
    load,
    clear: () => cache.clear(),
  };
}

async function readResponseBytes(
  response: Response,
  maxEncodedBytes: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxEncodedBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (byteLength === 0) return null;
  const encoded = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoded;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
