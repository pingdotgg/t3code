import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

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

  it.effect("stream emits the current snapshot first and then every change", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const collected = yield* tracker
        .stream(threadId)
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      // Give the subscription time to attach before publishing.
      yield* Effect.yieldNow;
      yield* tracker.stageStatus(threadId, "agent", "running");
      yield* tracker.appendTail(threadId, "agent", "line 1");

      const snapshots = yield* Fiber.join(collected);
      expect(snapshots.map((snapshot) => snapshot?.sequence)).toEqual([0, 1, 2]);
      expect(snapshots[2]?.stages[0]?.tail).toEqual(["line 1"]);
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
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);

      yield* tracker.finish(threadId, "cancelled");
      expect(yield* tracker.cancel(threadId)).toBe(false);
      expect(yield* tracker.cancel(ThreadId.make("unknown"))).toBe(false);
    }),
  );
});
