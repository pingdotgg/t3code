/**
 * Decode limits for untrusted design files. Agents can import any workspace
 * file, so a zip bomb or crafted `.fig` must fail instead of exhausting the
 * server's memory.
 */
import { Inflate } from "fflate";
import { Decompress as ZstdDecompress } from "fzstd";

const IMPORT_MAX_DECODED_BYTES = 512 * 1024 * 1024;

// @effect-diagnostics-next-line extendsNativeError:off - synchronous decoder throw sentinel; callers map it to a tagged error.
export class ImportLimitError extends Error {}

/** Running total of decompressed bytes for one import. */
export class DecodeBudget {
  private remaining: number;
  constructor(limit = IMPORT_MAX_DECODED_BYTES) {
    this.remaining = limit;
  }

  take(bytes: number): void {
    if (bytes > this.remaining) {
      throw new ImportLimitError("the file expands past the 512 MB import limit");
    }
    this.remaining -= bytes;
  }
}

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

// Small input pieces bound what one push can expand to (deflate tops out near 1032:1).
const INFLATE_PIECE = 16 * 1024;

/** Raw deflate, stopping once the output passes the budget. */
export function inflateWithin(data: Uint8Array, budget: DecodeBudget): Uint8Array {
  const parts: Uint8Array[] = [];
  const inflate = new Inflate((chunk) => {
    budget.take(chunk.length);
    parts.push(chunk);
  });
  if (data.length === 0) inflate.push(data, true);
  for (let offset = 0; offset < data.length; offset += INFLATE_PIECE) {
    const end = Math.min(offset + INFLATE_PIECE, data.length);
    inflate.push(data.subarray(offset, end), end === data.length);
  }
  return concat(parts);
}

/** fzstd allocates its history window before reporting any decoded output. */
function checkZstdWindows(data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const invalid = () => new Error("Invalid or truncated Zstandard frame");
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) throw invalid();
    const magic = view.getUint32(offset, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (offset + 8 > data.length) throw invalid();
      offset += 8 + view.getUint32(offset + 4, true);
      if (offset > data.length) throw invalid();
      continue;
    }
    if (magic !== 0xfd2fb528 || offset + 5 > data.length) throw invalid();
    const descriptor = data[offset + 4]!;
    const singleSegment = (descriptor & 0x20) !== 0;
    offset += 5;
    let window = 0;
    if (!singleSegment) {
      if (offset >= data.length) throw invalid();
      const descriptor = data[offset++]!;
      const base = 2 ** (10 + (descriptor >> 3));
      window = base + (base / 8) * (descriptor & 7);
    }
    offset += [0, 1, 2, 4][descriptor & 3]!;
    const sizeFlag = descriptor >> 6;
    const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
    if (offset + sizeBytes > data.length) throw invalid();
    if (singleSegment) {
      for (let index = 0; index < sizeBytes; index++)
        window += data[offset + index]! * 2 ** (8 * index);
      if (sizeFlag === 1) window += 256;
    }
    if (window > IMPORT_MAX_DECODED_BYTES)
      throw new ImportLimitError("the Zstandard frame exceeds the 512 MB import window limit");
    offset += sizeBytes;
    let last = false;
    do {
      if (offset + 3 > data.length) throw invalid();
      const header = data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
      const type = (header >> 1) & 3;
      if (type === 3) throw invalid();
      last = (header & 1) !== 0;
      offset += 3 + (type === 1 ? 1 : header >> 3);
      if (offset > data.length) throw invalid();
    } while (!last);
    if ((descriptor & 4) !== 0) offset += 4;
    if (offset > data.length) throw invalid();
  }
}

/** Zstandard, bounding its declared windows and decoded output before allocation. */
export function zstdWithin(data: Uint8Array, budget: DecodeBudget): Uint8Array {
  checkZstdWindows(data);
  const parts: Uint8Array[] = [];
  const decompress = new ZstdDecompress((chunk) => {
    budget.take(chunk.length);
    parts.push(chunk);
  });
  decompress.push(data, true);
  return concat(parts);
}
