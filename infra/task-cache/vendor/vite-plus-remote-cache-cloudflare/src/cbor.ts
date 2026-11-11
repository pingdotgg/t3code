import { badRequest, tooLarge } from './errors.ts';
import type { Limits } from './limits.ts';

export interface FetchRequest {
  key: Uint8Array;
  secondary_key: Uint8Array;
}

export interface StoreMetadata extends FetchRequest {
  value: Uint8Array;
}

// This codec only decodes the protocol envelope. Opaque bytes are never decoded.
// The accepted containers are one map and (possibly chunked) strings: depth <= 2.
class Decoder {
  offset = 0;
  constructor(private data: Uint8Array) {}
  byte(): number {
    return this.data[this.offset++] ?? badRequest();
  }
  head(major: number): number | null {
    const first = this.byte();
    if (first >> 5 !== major) badRequest();
    const info = first & 31;
    if (info < 24) return info;
    if (info === 31) return null;
    if (info > 27) badRequest();
    let length = 0;
    for (let i = 0; i < 2 ** (info - 24); i++) length = length * 256 + this.byte();
    if (!Number.isSafeInteger(length)) tooLarge();
    return length;
  }
  string(major: number, limit: number): Uint8Array {
    const length = this.head(major);
    if (length !== null) return this.take(length, limit);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (this.data[this.offset] !== 255) {
      const chunkLength = this.head(major);
      if (chunkLength === null) badRequest();
      size += chunkLength;
      if (size > limit) tooLarge();
      chunks.push(this.take(chunkLength, limit));
      // Bound bookkeeping even for a malicious sequence of empty chunks.
      if (chunks.length > 4096) tooLarge();
    }
    this.offset++;
    return join(chunks, size);
  }
  take(size: number, limit: number): Uint8Array {
    if (size > limit) tooLarge();
    if (size > this.data.length - this.offset) badRequest();
    const value = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  finished(): boolean {
    return this.offset === this.data.length;
  }
  break(): boolean {
    if (this.data[this.offset] !== 255) return false;
    this.offset++;
    return true;
  }
}

export function join(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

export function decodeEnvelope(data: Uint8Array, store: false, limits: Limits): FetchRequest;
export function decodeEnvelope(data: Uint8Array, store: true, limits: Limits): StoreMetadata;
export function decodeEnvelope(
  data: Uint8Array,
  store: boolean,
  limits: Limits,
): FetchRequest | StoreMetadata {
  const decoder = new Decoder(data);
  const count = decoder.head(5);
  const expected = store ? 3 : 2;
  if (count !== null && count !== expected) badRequest();
  const fields = new Map<string, Uint8Array>();
  for (let i = 0; i < expected; i++) {
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        decoder.string(3, 32),
      );
    } catch {
      badRequest();
    }
    const allowed = name === 'key' || name === 'secondary_key' || (store && name === 'value');
    if (!allowed || fields.has(name)) badRequest();
    fields.set(name, decoder.string(2, name === 'value' ? limits.value : limits.key));
  }
  if ((count === null && !decoder.break()) || !decoder.finished()) badRequest();
  return {
    key: fields.get('key')!,
    secondary_key: fields.get('secondary_key')!,
    ...(store ? { value: fields.get('value')! } : {}),
  };
}

function header(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length <= 255) return Uint8Array.of((major << 5) | 24, length);
  if (length <= 65535) return Uint8Array.of((major << 5) | 25, length >> 8, length & 255);
  return Uint8Array.of(
    (major << 5) | 26,
    length >>> 24,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
  );
}

export function encodeEnvelope(
  fields: Record<string, string | Uint8Array | null>,
): Uint8Array<ArrayBuffer> {
  const chunks = [header(5, Object.keys(fields).length)];
  const string = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    chunks.push(header(typeof value === 'string' ? 3 : 2, bytes.length), bytes);
  };
  for (const [key, value] of Object.entries(fields)) {
    string(key);
    if (value === null) chunks.push(Uint8Array.of(246));
    else string(value);
  }
  return join(
    chunks,
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
}

export function cborResponse(fields: Record<string, string | Uint8Array | null>): Response {
  const body = encodeEnvelope(fields);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/cbor',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    },
  });
}
