import { DateTime, Effect, Option } from "effect";

export const nowFreshness = Effect.fn("VcsFreshness.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});
