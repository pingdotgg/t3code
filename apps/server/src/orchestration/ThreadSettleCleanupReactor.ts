/**
 * ThreadSettleCleanupReactor - Settled-thread worktree cleanup reactor.
 *
 * Owns background workers that react to thread settlement domain events and
 * perform best-effort disk cleanup of regenerable build artifacts in the
 * settled thread's worktree.
 *
 * @module ThreadSettleCleanupReactor
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { isLinkedWorktreePath, removeWorktreeArtifacts } from "../git/worktreeArtifacts.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

type ThreadSettledEvent = Extract<OrchestrationEvent, { type: "thread.settled" }>;

/**
 * ThreadSettleCleanupReactor - Service tag for settle-time worktree cleanup
 * workers.
 */
export class ThreadSettleCleanupReactor extends Context.Service<
  ThreadSettleCleanupReactor,
  {
    /**
     * Start reacting to thread.settled orchestration domain events.
     *
     * The returned effect must be run in a scope so all worker fibers can be
     * finalized on shutdown.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;

    /**
     * Resolves once every thread.settled at or before the supplied event
     * sequence has been handed to the worker and the worker is empty and
     * idle. Intended for test use to replace timing-sensitive sleeps.
     */
    readonly drainThrough: (sequence: number) => Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettleCleanupReactor") {}

const normalizeWorktreePath = (path: string | null): string | null => {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
};

/**
 * Whether another live thread points at the same worktree, in which case the
 * settling thread does not own the directory and must leave it alone.
 */
export const isWorktreeSharedWithAnotherThread = (
  threads: ReadonlyArray<Pick<ProjectionThread, "threadId" | "worktreePath" | "deletedAt">>,
  target: Pick<ProjectionThread, "threadId" | "worktreePath">,
): boolean => {
  const targetWorktreePath = normalizeWorktreePath(target.worktreePath);
  if (!targetWorktreePath) {
    return false;
  }
  return threads.some(
    (thread) =>
      thread.threadId !== target.threadId &&
      thread.deletedAt === null &&
      normalizeWorktreePath(thread.worktreePath) === targetWorktreePath,
  );
};

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionThreads = yield* ProjectionThreadRepository;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const processThreadSettled = Effect.fn("processThreadSettled")(function* (
    event: ThreadSettledEvent,
  ) {
    const { threadId } = event.payload;
    const settings = yield* serverSettings.getSettings;
    if (!settings.cleanWorktreeArtifactsOnSettle) {
      return;
    }

    const thread = Option.getOrNull(yield* projectionThreads.getById({ threadId }));
    const worktreePath = normalizeWorktreePath(thread?.worktreePath ?? null);
    if (!thread || thread.deletedAt !== null || !worktreePath) {
      return;
    }

    // Events are projected before they are published, so the projection row
    // is current by the time this worker dequeues. A thread unsettled after
    // this event was queued no longer reads "settled" here, which keeps a
    // stale settle from cleaning under a resuming turn.
    if (thread.settledOverride !== "settled") {
      return;
    }

    const projectThreads = yield* projectionThreads.listByProjectId({
      projectId: thread.projectId,
    });
    if (isWorktreeSharedWithAnotherThread(projectThreads, thread)) {
      return;
    }

    // Only linked worktrees are cleaned; a thread running directly in the
    // project's primary checkout keeps its caches.
    if (!(yield* isLinkedWorktreePath(worktreePath))) {
      return;
    }

    const { removed, failed, skipped } = yield* removeWorktreeArtifacts(worktreePath);
    if (removed.length > 0 || failed.length > 0 || skipped.length > 0) {
      yield* Effect.logInfo("settle cleanup removed worktree build artifacts", {
        threadId,
        worktreePath,
        removed,
        failed,
        skipped,
      });
    }
  });

  const processThreadSettledSafely = (event: ThreadSettledEvent) =>
    processThreadSettled(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logDebug("settle cleanup reactor skipped worktree cleanup", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadSettledSafely);

  // Highest event sequence this subscriber has handed to the worker. The
  // watermark only advances for events the subscription actually delivered,
  // so drainThrough never reports coverage of an event this reactor missed.
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ThreadSettleCleanupReactor["Service"]["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        (event.type === "thread.settled" ? worker.enqueue(event) : Effect.void).pipe(
          Effect.andThen(noteSeen(event.sequence)),
        ),
      ),
    );
  });

  const drainThrough: ThreadSettleCleanupReactor["Service"]["drainThrough"] = Effect.fn(
    "ThreadSettleCleanupReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return {
    start,
    drainThrough,
  } satisfies ThreadSettleCleanupReactor["Service"];
});

export const layer = Layer.effect(ThreadSettleCleanupReactor, make);
