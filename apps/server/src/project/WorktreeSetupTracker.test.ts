import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorktreeSetupTracker from "./WorktreeSetupTracker.ts";

const threadId = ThreadId.make("thread-1");

describe("WorktreeSetupTracker", () => {
  it.effect("records stage transitions, checkout progress, and the final phase", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: "feature",
        baseRef: "main",
        stages: ["checkout", "fetch", "agent"],
        fiber: null,
      });

      const initial = yield* tracker.get(threadId);
      // Stages are reordered into the canonical setup order.
      expect(initial?.stages.map((stage) => stage.id)).toEqual(["fetch", "checkout", "agent"]);
      expect(initial?.phase).toBe("running");

      yield* tracker.stageStatus(threadId, "fetch", "running");
      yield* tracker.stageStatus(threadId, "fetch", "done", "origin/main at abc1234");
      yield* tracker.stageStatus(threadId, "checkout", "running");
      yield* tracker.stage(threadId, "checkout", { percent: 42, detail: "42 / 100 files" });
      yield* tracker.finish(threadId, "failed", "boom");

      const final = yield* tracker.get(threadId);
      expect(final?.phase).toBe("failed");
      expect(final?.error).toBe("boom");
      const [fetch, checkout, agent] = final?.stages ?? [];
      expect(fetch).toMatchObject({ status: "done", detail: "origin/main at abc1234" });
      expect(fetch?.startedAt).not.toBeNull();
      expect(fetch?.endedAt).not.toBeNull();
      // A stage still running when the setup fails is marked failed.
      expect(checkout).toMatchObject({ status: "failed", percent: 42 });
      expect(agent?.status).toBe("pending");
      expect(final?.sequence).toBeGreaterThan(initial?.sequence ?? 0);
    }),
  );

  it.effect("stream emits the current snapshot first and then only newer ones", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.sequence === 2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.stageStatus(threadId, "agent", "running");
      yield* tracker.appendTail(threadId, "agent", "line 1");

      const snapshots = yield* Fiber.join(collected);
      const sequences = snapshots.map((snapshot) => snapshot?.sequence ?? -1);
      expect(sequences.at(-1)).toBe(2);
      // Delivery is latest-value per subscriber, so intermediates may be
      // skipped but never delivered out of order.
      expect(sequences).toEqual([...sequences].toSorted((a, b) => a - b));
      expect(snapshots.at(-1)?.stages[0]?.tail).toEqual(["line 1"]);
    }),
  );

  it.effect("stream never steps back behind the snapshot it started from", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.stageStatus(threadId, "agent", "running");
      yield* tracker.stageStatus(threadId, "agent", "done");

      // A late subscriber starts at sequence 2 and must never see 0 or 1.
      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.finish(threadId, "done");

      const snapshots = yield* Fiber.join(collected);
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.every((snapshot) => (snapshot?.sequence ?? -1) >= 2)).toBe(true);
      expect(snapshots.at(-1)?.phase).toBe("done");
    }),
  );

  it.effect("a new setup on the same thread keeps sequences increasing", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: "first",
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.finish(threadId, "failed", "boom");
      const failedSequence = (yield* tracker.get(threadId))?.sequence ?? -1;

      // A stream opened on the failed setup must still receive the next one.
      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.branch === "second"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.begin({
        threadId,
        branch: "second",
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const snapshots = yield* Fiber.join(collected);
      const last = snapshots.at(-1);
      expect(last?.phase).toBe("running");
      expect(last?.sequence).toBeGreaterThan(failedSequence);
    }),
  );

  it.effect("finished setups are dropped after the retention window", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.finish(threadId, "done");
      expect((yield* tracker.get(threadId))?.phase).toBe("done");

      yield* TestClock.adjust(Duration.seconds(31));
      expect(yield* tracker.get(threadId)).toBeNull();
    }),
  );

  it.effect("cancel interrupts the bootstrap fiber and reports whether one was running", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const started = yield* Deferred.make<void>();
      const fiber = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* tracker.begin({ threadId, branch: null, baseRef: null, stages: ["agent"], fiber });

      expect(yield* tracker.cancel(threadId)).toBe(true);
      // cancel returns only after the bootstrap fiber has unwound.
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);

      yield* tracker.finish(threadId, "cancelled");
      expect(yield* tracker.cancel(threadId)).toBe(false);
      expect(yield* tracker.cancel(ThreadId.make("unknown"))).toBe(false);
    }),
  );
});
