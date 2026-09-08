import { retryWorkerScriptNotFound } from "@/Cloudflare/Email/retry";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

// Cloudflare rejects a rule whose `worker` action names a script it cannot see
// yet with code 2016 / `WorkerScriptNotFound`. Distilled surfaces that as a
// tagged error; only the tag matters to the retry, so a minimal stand-in keeps
// this test free of the generated SDK.
class WorkerScriptNotFound {
  readonly _tag = "WorkerScriptNotFound";
  constructor(readonly code = 2016) {}
}
class SomethingElse {
  readonly _tag = "Conflict";
}

// Fails the first `failures` attempts with `error`, then succeeds.
const flaky = <E>(failures: number, error: E) => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    effect: Effect.suspend(() => {
      attempts++;
      return attempts <= failures ? Effect.fail(error) : Effect.succeed("ok");
    }),
  };
};

// The live suite (EmailRuleWorkerTarget.test.ts) cannot exercise this window —
// the Worker provider pre-creates a stub script, so the name already resolves
// by the time the rule is validated, and that suite passes with the retry
// removed. These cases inject the failure instead, so they fail if the retry
// regresses.
//
// `it.live` uses the real clock so the backoff actually elapses; the default
// `it.effect` TestClock would never advance it.
describe("retryWorkerScriptNotFound", () => {
  it.live("retries while the script is not yet visible, then succeeds", () =>
    Effect.gen(function* () {
      const target = flaky(2, new WorkerScriptNotFound());

      const result = yield* retryWorkerScriptNotFound(target.effect);

      expect(result).toBe("ok");
      // Two not-visible-yet failures plus the success.
      expect(target.attempts()).toBe(3);
    }),
  );

  it.live("does not retry an unrelated failure", () =>
    Effect.gen(function* () {
      const target = flaky(99, new SomethingElse());

      const outcome = yield* Effect.result(
        retryWorkerScriptNotFound(target.effect),
      );

      expect(outcome._tag).toBe("Failure");
      // Attempted once and given up — no backoff burned on a permanent error.
      expect(target.attempts()).toBe(1);
    }),
  );

  it.live(
    "gives up after a bounded budget and re-raises the original error",
    () =>
      Effect.gen(function* () {
        const error = new WorkerScriptNotFound();
        // Never recovers: a genuinely missing Worker must still fail and say so
        // rather than hanging.
        const target = flaky(Number.MAX_SAFE_INTEGER, error);

        const outcome = yield* Effect.result(
          retryWorkerScriptNotFound(target.effect),
        );

        expect(outcome._tag).toBe("Failure");
        // The error surfaces unchanged, not wrapped in a retry-exhausted error.
        if (outcome._tag === "Failure") {
          expect(outcome.failure).toBe(error);
        }
        // `times: 8` — the initial attempt plus eight retries, and no more.
        expect(target.attempts()).toBe(9);
      }),
    // ~25s of exponential backoff from 100ms, plus headroom.
    { timeout: 60_000 },
  );
});
