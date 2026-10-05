import { retryWorkerScriptNotFound } from "@/Cloudflare/Email/retry";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

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
// Advance virtual time to exercise the production backoff without wall-clock waits.
describe(
  "retryWorkerScriptNotFound",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:email", "local"],
  },
  () => {
    it.effect(
      "retries while the script is not yet visible, then succeeds",
      () =>
        Effect.gen(function* () {
          const target = flaky(2, new WorkerScriptNotFound());

          const fiber = yield* retryWorkerScriptNotFound(target.effect).pipe(
            Effect.forkChild,
          );
          yield* TestClock.adjust("1 second");
          const result = yield* Fiber.join(fiber);

          expect(result).toBe("ok");
          // Two not-visible-yet failures plus the success.
          expect(target.attempts()).toBe(3);
        }),
    );

    it.effect("does not retry an unrelated failure", () =>
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

    it.effect(
      "gives up after a bounded budget and re-raises the original error",
      () =>
        Effect.gen(function* () {
          const error = new WorkerScriptNotFound();
          // Never recovers: a genuinely missing Worker must still fail and say so
          // rather than hanging.
          const target = flaky(Number.MAX_SAFE_INTEGER, error);

          const fiber = yield* Effect.result(
            retryWorkerScriptNotFound(target.effect),
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("30 seconds");
          const outcome = yield* Fiber.join(fiber);

          expect(outcome._tag).toBe("Failure");
          // The error surfaces unchanged, not wrapped in a retry-exhausted error.
          if (outcome._tag === "Failure") {
            expect(outcome.failure).toBe(error);
          }
          // `times: 8` — the initial attempt plus eight retries, and no more.
          expect(target.attempts()).toBe(9);
        }),
      // Bound regressions even if virtual retries stop making progress.
      { timeout: 5_000 },
    );
  },
);
