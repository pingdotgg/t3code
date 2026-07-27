import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";

/**
 * MD5 hex digest of the given data. Wrapped in `Effect.sync` so the call
 * participates in the Effect runtime (tracing/interruption) per the
 * Effect-platform conventions.
 */
export const md5 = (data: string | Uint8Array): Effect.Effect<string> =>
  Effect.sync(() => createHash("md5").update(data).digest("hex"));
