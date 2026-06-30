import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  beginProviderFallbackTrial,
  completeProviderFallbackTrial,
  decideProviderFallbackTrialEvent,
} from "./providerFallbackTrialGate.ts";

const threadId = ThreadId.make("thread-fallback-gate");
const instanceId = ProviderInstanceId.make("codex-work");

describe("provider fallback trial event gate", () => {
  it.effect("holds provisional events and rejects them when the trial fails", () =>
    Effect.gen(function* () {
      const token = yield* beginProviderFallbackTrial(threadId, instanceId);
      const decision = yield* decideProviderFallbackTrialEvent(
        threadId,
        instanceId,
        DateTime.formatIso(DateTime.makeUnsafe(token.startedAtMs + 1)),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* completeProviderFallbackTrial(token, "reject");

      expect(yield* Fiber.join(decision)).toBe("reject");
    }),
  );

  it.effect("releases provisional events only after the trial commits", () =>
    Effect.gen(function* () {
      const token = yield* beginProviderFallbackTrial(threadId, instanceId);
      const decision = yield* decideProviderFallbackTrialEvent(
        threadId,
        instanceId,
        DateTime.formatIso(DateTime.makeUnsafe(token.startedAtMs + 1)),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* completeProviderFallbackTrial(token, "accept");

      expect(yield* Fiber.join(decision)).toBe("accept");
    }),
  );

  it.effect("does not apply an old trial outcome to later events from the same instance", () =>
    Effect.gen(function* () {
      const token = yield* beginProviderFallbackTrial(threadId, instanceId);
      yield* completeProviderFallbackTrial(token, "reject");

      expect(
        yield* decideProviderFallbackTrialEvent(
          threadId,
          instanceId,
          DateTime.formatIso(DateTime.makeUnsafe(token.startedAtMs + 60_000)),
        ),
      ).toBe("not-trial");
    }),
  );
});
