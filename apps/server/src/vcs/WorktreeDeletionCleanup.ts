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

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
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

export const make = (domainEvents: Stream.Stream<OrchestrationV2DomainEvent, unknown>) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const worktrees = yield* WorktreeService;
    const started = yield* Ref.make(false);

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

      yield* domainEvents.pipe(
        Stream.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Stream.fromEffect(
              Effect.logWarning("worktree.deletion-cleanup.stream-failed", {
                cause,
              }).pipe(Effect.andThen(Effect.fail(cause))),
            ),
        ),
        Stream.retry(Schedule.exponential("1 second")),
        Stream.runForEach((event) => {
          const request = threadDeletionCleanupRequest(event);
          return request === null ? Effect.void : worker.enqueue(request);
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

export const layer = Layer.effect(
  WorktreeDeletionCleanup,
  ThreadManagementService.pipe(Effect.flatMap((threads) => make(threads.streamDomainEvents))),
);

export const layerWithEventStream = (
  domainEvents: Stream.Stream<OrchestrationV2DomainEvent, unknown>,
) => Layer.effect(WorktreeDeletionCleanup, make(domainEvents));

/** Exposed for tests. */
export const __testing = {
  recoverDeletionFailure,
};
