import {
  ThreadId,
  type WorktreeSetupStageId,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import { awaitSyncSetupScriptCompletion } from "./ws.ts";

interface StageStatusCall {
  readonly stageId: WorktreeSetupStageId;
  readonly status: WorktreeSetupStageStatus;
  readonly detail: string | null;
}

const makeRecordingTracker = () => {
  const calls: Array<StageStatusCall> = [];
  const service = {
    stageStatus: (
      _threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      status: WorktreeSetupStageStatus,
      detail?: string | null,
    ) =>
      Effect.sync(() => {
        calls.push({ stageId, status, detail: detail ?? null });
      }),
  } as unknown as WorktreeSetupTracker.WorktreeSetupTracker["Service"];
  return { calls, service };
};

it.effect("marks the setup-script stage failed when a sync setup script never settles", () =>
  Effect.gen(function* () {
    const { calls, service } = makeRecordingTracker();
    const threadId = ThreadId.make("thread-sync-setup-timeout");
    // A wedged script: never prints the sentinel, never exits, so the
    // completion deferred never settles.
    const done = yield* Deferred.make<void>();
    const completionFiber = yield* Effect.forkDetach(Deferred.await(done));

    const joinFiber = yield* Effect.forkChild(
      awaitSyncSetupScriptCompletion(completionFiber, {
        threadId,
        worktreeSetupTracker: service,
      }),
    );
    // The forked join is scheduled at the current clock time, so this
    // adjust runs its timeout registration before moving past the deadline:
    // the timeout cannot be skipped and the test cannot pass vacuously.
    yield* TestClock.adjust(Duration.minutes(31));

    // The join returned instead of wedging the bootstrap forever.
    yield* Fiber.join(joinFiber);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.stageId, "setup-script");
    assert.equal(calls[0]?.status, "failed");
    assert.match(calls[0]?.detail ?? "", /setup script timed out after 30m/);

    // The completion fiber was reaped: its terminal listener is unsubscribed.
    // The terminal itself is left alone for the user to inspect on the card.
    const completionExit = yield* Fiber.await(completionFiber);
    assert.isTrue(Exit.hasInterrupts(completionExit));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("marks the setup-script stage done when the script settles before the timeout", () =>
  Effect.gen(function* () {
    const { calls, service } = makeRecordingTracker();
    const threadId = ThreadId.make("thread-sync-setup-done");
    const done = yield* Deferred.make<void>();
    // Mirror the production completion fiber: settle, then mark the stage.
    const completionFiber = yield* Effect.forkDetach(
      Deferred.await(done).pipe(
        Effect.andThen(service.stageStatus(threadId, "setup-script", "done")),
      ),
    );

    const joinFiber = yield* Effect.forkChild(
      awaitSyncSetupScriptCompletion(completionFiber, {
        threadId,
        worktreeSetupTracker: service,
      }),
    );
    yield* Deferred.succeed(done, undefined);
    yield* Fiber.join(joinFiber);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.stageId, "setup-script");
    assert.equal(calls[0]?.status, "done");
  }).pipe(Effect.provide(TestClock.layer())),
);
