import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { ConcurrencyLimits, ConcurrencyLimitsLive } from "../ConcurrencyLimits.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

describe("ConcurrencyLimits", () => {
  it.effect("atomically reserves and binds capacity", () =>
    Effect.gen(function* () {
      const limits = yield* ConcurrencyLimits;
      const reservation = yield* limits.reserve(codex, "gpt-4o-mini");
      yield* limits.bindReservation(reservation, "thread-1");
      const result = yield* limits.getActiveCount("gpt-4o-mini");

      expect(result).toBe(1);
    }).pipe(Effect.provide(ConcurrencyLimitsLive)),
  );

  it.effect("rejects concurrent reservations beyond the model limit", () =>
    Effect.gen(function* () {
      const limits = yield* ConcurrencyLimits;
      const exits = yield* Effect.all(
        Array.from({ length: 6 }, () => limits.reserve(claude, "claude-fable-5").pipe(Effect.exit)),
        { concurrency: "unbounded" },
      );

      expect(exits.filter(Exit.isSuccess)).toHaveLength(5);
      expect(exits.filter(Exit.isFailure)).toHaveLength(1);
    }).pipe(Effect.provide(ConcurrencyLimitsLive)),
  );

  it.effect("tracks models independently and releases by thread id", () =>
    Effect.gen(function* () {
      const limits = yield* ConcurrencyLimits;
      const first = yield* limits.reserve(codex, "gpt-4o-mini");
      const second = yield* limits.reserve(claude, "claude-sonnet-5");
      yield* limits.bindReservation(first, "thread-1");
      yield* limits.bindReservation(second, "thread-2");

      const before = yield* limits.getActiveCount();
      yield* limits.release("thread-1");
      const result = {
        before,
        after: yield* limits.getActiveCount(),
        cheap: yield* limits.getActiveCount("gpt-4o-mini"),
        moderate: yield* limits.getActiveCount("claude-sonnet-5"),
      };

      expect(result).toEqual({ before: 2, after: 1, cheap: 0, moderate: 1 });
    }).pipe(Effect.provide(ConcurrencyLimitsLive)),
  );
});
