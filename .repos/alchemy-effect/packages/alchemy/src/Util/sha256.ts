import * as Effect from "effect/Effect";
import { stableValue } from "./stable.ts";

type Input = ArrayBuffer | Uint8Array | string;

export const sha256 = (input: Input) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(input));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  });

export const sha256Object = (input: object) =>
  sha256(JSON.stringify(stableValue(input)));

/**
 * Stable sha256 hex digest of a resolved Task input. Unlike
 * {@link sha256Object} this does not stabilize key ordering — it hashes the
 * raw `JSON.stringify(input ?? null)` so identical inputs map to identical
 * hashes for caching/equality checks.
 */
export const hashInput = (input: unknown): Effect.Effect<string> =>
  sha256(JSON.stringify(input ?? null));

const toArrayBuffer = (input: Input) => {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
};
