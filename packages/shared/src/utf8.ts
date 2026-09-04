const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface Utf8Chunk {
  readonly data: string;
  readonly byteLength: number;
}

/**
 * Split a string into chunks of at most `maxBytes` UTF-8 bytes without cutting
 * a code point in half. Used by the terminal pipeline on both the server
 * (bounded output batches, streamed history) and clients (retained output
 * chunks) so both sides split identical streams at identical byte boundaries.
 *
 * A chunk that fits whole is returned as the original string, so the common
 * small-write path pays one encode and no decode.
 */
export function splitStringByUtf8Bytes(data: string, maxBytes: number): ReadonlyArray<Utf8Chunk> {
  if (data.length === 0) return [];

  const encoded = textEncoder.encode(data);
  if (encoded.byteLength <= maxBytes) {
    return [{ data, byteLength: encoded.byteLength }];
  }

  const chunks: Utf8Chunk[] = [];
  let offset = 0;
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maxBytes, encoded.byteLength);
    while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    // A degenerate budget smaller than one code point still has to advance:
    // include the whole code point rather than looping forever.
    if (end === offset) {
      end = Math.min(offset + maxBytes, encoded.byteLength);
      while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
        end += 1;
      }
    }
    const bytes = encoded.subarray(offset, end);
    chunks.push({ data: textDecoder.decode(bytes), byteLength: bytes.byteLength });
    offset = end;
  }

  return chunks;
}
