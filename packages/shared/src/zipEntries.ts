/**
 * Minimal ZIP reader for container formats such as 3MF: lists entries from the central directory
 * and reads one entry, stored or deflated, with a cap on its inflated size. ZIP64 archives and
 * other compression methods are not supported.
 */

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_OF_DIRECTORY_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

export interface ZipEntry {
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** Entries by name, or `null` when `bytes` is not a ZIP archive this reader understands. */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - END_OF_DIRECTORY_BYTES - MAX_COMMENT_BYTES);
  let end = -1;
  for (let at = bytes.length - END_OF_DIRECTORY_BYTES; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) return null;
    const nameLength = view.getUint16(at + 28, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

/** The entry's stored bytes, or `null` when its header is damaged. */
function entryData(bytes: Uint8Array, entry: ZipEntry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localOffset;
  if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER) return null;
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  return data.length === entry.compressedSize ? data : null;
}

/**
 * Passes the entry's contents to `onChunk` piece by piece, so callers never hold it whole. Returns
 * `false` when it is damaged, compressed unusually, or inflates past `maxBytes`.
 */
export async function streamZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<boolean> {
  if (entry.size > maxBytes) return false;
  const data = entryData(bytes, entry);
  if (!data || (entry.method !== 0 && entry.method !== 8)) return false;
  if (entry.method === 0) {
    await onChunk(data);
    return true;
  }
  // The declared size can lie, so count while inflating instead of trusting it.
  // Streams accept only views of plain ArrayBuffers; copy in the rare shared-memory case.
  const input =
    data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice();
  const reader = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  let length = 0;
  try {
    while (true) {
      const next = await reader.read().catch(() => null);
      if (!next) return false;
      if (next.done) return true;
      length += next.value.length;
      if (length > maxBytes) return false;
      await onChunk(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** The whole entry, for small parts; `null` when it cannot be read or is over `maxBytes`. */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const complete = await streamZipEntry(bytes, entry, maxBytes, (chunk) => {
    chunks.push(chunk);
    length += chunk.length;
  });
  if (!complete) return null;
  if (chunks.length === 1) return chunks[0]!;
  const whole = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.length;
  }
  return whole;
}
