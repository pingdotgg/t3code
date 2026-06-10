import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";

export function randomHex(byteLength: number): string {
  return Encoding.encodeHex(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Encoding.encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const randomUUIDv4: Effect.Effect<string> = Effect.sync(randomUUID);
