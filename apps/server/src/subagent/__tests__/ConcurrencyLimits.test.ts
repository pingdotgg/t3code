import { describe, it, expect } from "vitest";
import * as Effect from "effect/Effect";
import { ConcurrencyLimits, ConcurrencyLimitsLive } from "../ConcurrencyLimits.ts";

describe("ConcurrencyLimits", () => {
  it("should allow spawn within cheap model limit", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const limits = yield* ConcurrencyLimits;

        // Spawn cheap model - should succeed
        yield* limits.checkCanSpawn("codex", "gpt-4o-mini");
        yield* limits.registerSpawn("thread-1", "codex", "gpt-4o-mini");

        const count = yield* limits.getActiveCount("gpt-4o-mini");
        return count;
      }).pipe(Effect.provide(ConcurrencyLimitsLive)),
    );

    expect(result).toBe(1);
  });

  it("should reject spawn when model limit exceeded", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const limits = yield* ConcurrencyLimits;

        // Fill expensive model limit (5)
        for (let i = 0; i < 5; i++) {
          yield* limits.registerSpawn(`thread-${i}`, "claudeAgent", "claude-fable-5");
        }

        // Try to spawn 6th - should fail
        return yield* limits.checkCanSpawn("claudeAgent", "claude-fable-5");
      }).pipe(
        Effect.provide(ConcurrencyLimitsLive),
        Effect.match({
          onSuccess: () => "allowed",
          onFailure: (error) => error._tag,
        }),
      ),
    );

    expect(result).toBe("SubAgentError");
  });

  it("should track different models independently", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const limits = yield* ConcurrencyLimits;

        yield* limits.registerSpawn("thread-1", "codex", "gpt-4o-mini");
        yield* limits.registerSpawn("thread-2", "claudeAgent", "claude-sonnet-5");

        const cheapCount = yield* limits.getActiveCount("gpt-4o-mini");
        const moderateCount = yield* limits.getActiveCount("claude-sonnet-5");
        const totalCount = yield* limits.getActiveCount();

        return { cheapCount, moderateCount, totalCount };
      }).pipe(Effect.provide(ConcurrencyLimitsLive)),
    );

    expect(result.cheapCount).toBe(1);
    expect(result.moderateCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });

  it("should unregister spawns correctly", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const limits = yield* ConcurrencyLimits;

        yield* limits.registerSpawn("thread-1", "codex", "gpt-4o-mini");
        yield* limits.registerSpawn("thread-2", "codex", "gpt-4o-mini");

        const beforeCount = yield* limits.getActiveCount("gpt-4o-mini");

        yield* limits.unregisterSpawn("thread-1");

        const afterCount = yield* limits.getActiveCount("gpt-4o-mini");

        return { beforeCount, afterCount };
      }).pipe(Effect.provide(ConcurrencyLimitsLive)),
    );

    expect(result.beforeCount).toBe(2);
    expect(result.afterCount).toBe(1);
  });
});
