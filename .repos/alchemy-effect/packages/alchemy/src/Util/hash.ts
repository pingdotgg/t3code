import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";

/**
 * Stable hash of a resolved Task input. Wrapped in `Effect.sync` so the
 * call participates in the Effect runtime (tracing/interruption) per the
 * Effect-platform conventions.
 */
export const hashInput = (input: unknown): Effect.Effect<string> =>
  Effect.sync(() =>
    createHash("sha256")
      .update(JSON.stringify(input ?? null))
      .digest("hex"),
  );
