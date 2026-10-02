import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

export const randomUuidV4 = Effect.all(
  Array.from({ length: 16 }, () => Random.nextIntBetween(0, 256, { halfOpen: true })),
).pipe(
  Effect.map((bytes) => {
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }),
);
