import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { WorktreeService } from "./WorktreeService.ts";

export interface ThreadDeletionCleanupRequest {
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
}

const recoverDeletionFailure =
  (request: ThreadDeletionCleanupRequest) =>
  <E, R>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("worktree.deletion-cleanup.failed", {
            threadId: request.threadId,
            worktreePath: request.worktreePath,
            cause,
          }),
      ),
    );

export function threadDeletionCleanupRequest(
  event: OrchestrationV2DomainEvent,
): ThreadDeletionCleanupRequest | null {
  if (event.type !== "thread.deleted") return null;
  return {
    threadId: event.threadId,
    worktreePath: event.payload.worktreePath,
  };
}

export class WorktreeDeletionCleanup extends Context.Service<
  WorktreeDeletionCleanup,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly enqueue: (request: ThreadDeletionCleanupRequest) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/vcs/WorktreeDeletionCleanup") {}

export const make = Effect.gen(function* () {
  const events = yield* EventSinkV2;
  const settings = yield* ServerSettingsService;
  const worktrees = yield* WorktreeService;
  const started = yield* Ref.make(false);
  const lastSequence = yield* Ref.make<number | null>(null);

  const processDeletion = Effect.fn("WorktreeDeletionCleanup.processDeletion")(function* (
    request: ThreadDeletionCleanupRequest,
  ) {
    if (request.worktreePath === null) return;

    const policy = (yield* settings.getSettings).worktrees;
    if (!policy.deleteOrphanedImmediately) return;

    const removed = yield* worktrees.pruneOrphanedWorktree(request.worktreePath);
    if (removed) {
      yield* Effect.logInfo("worktree.deletion-cleanup.removed", {
        threadId: request.threadId,
        worktreePath: request.worktreePath,
      });
    }
  });

  const worker = yield* makeDrainableWorker((request: ThreadDeletionCleanupRequest) =>
    processDeletion(request).pipe(recoverDeletionFailure(request)),
  );

  const start: WorktreeDeletionCleanup["Service"]["start"] = Effect.fn(
    "WorktreeDeletionCleanup.start",
  )(function* () {
    const shouldStart = yield* Ref.modify(started, (isStarted) => [!isStarted, true]);
    if (!shouldStart) return;

    const storedEvents = Stream.unwrap(
      Ref.get(lastSequence).pipe(
        Effect.flatMap((current) =>
          current === null
            ? events.latestSequence().pipe(
                // Re-fail instead of defaulting to 0: a zero high-water mark would
                // replay every historical thread.deleted event against the current
                // policy. The stream-level retry below re-runs this lookup.
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning("worktree.deletion-cleanup.initial-sequence-failed", {
                      cause,
                    }).pipe(Effect.andThen(Effect.failCause(cause))),
                ),
                Effect.tap((sequence) => Ref.set(lastSequence, sequence)),
              )
            : Effect.succeed(current),
        ),
        Effect.map((afterSequence) => events.stream({ afterSequence })),
      ),
    );

    yield* storedEvents.pipe(
      Stream.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Stream.fromEffect(
            Effect.logWarning("worktree.deletion-cleanup.stream-failed", {
              cause,
            }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
      ),
      Stream.retry(Schedule.exponential("1 second")),
      Stream.runForEach((stored) => {
        const request = threadDeletionCleanupRequest(stored.event);
        const enqueue = request === null ? Effect.void : worker.enqueue(request);
        return enqueue.pipe(Effect.andThen(Ref.set(lastSequence, stored.sequence)));
      }),
      Effect.forkScoped,
    );
  });

  return WorktreeDeletionCleanup.of({
    start,
    enqueue: worker.enqueue,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(WorktreeDeletionCleanup, make);

/** Exposed for tests. */
export const __testing = {
  recoverDeletionFailure,
};
