import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadColdStorage } from "../Services/ThreadColdStorage.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;
type ThreadLifecycleJob =
  | { readonly type: "archive"; readonly threadId: ThreadArchivedEvent["payload"]["threadId"] }
  | { readonly type: "delete"; readonly threadId: ThreadDeletedEvent["payload"]["threadId"] }
  | { readonly type: "compact-legacy-storage" };

export const THREAD_LIFECYCLE_RETRY_DELAY = "30 seconds";

function lifecycleJobKey(job: ThreadLifecycleJob): string {
  return job.type === "compact-legacy-storage" ? job.type : `${job.type}:${job.threadId}`;
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const projectionThreadSessions = yield* ProjectionThreadSessionRepository;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const threadColdStorage = yield* ThreadColdStorage;
  const providerEventLoggers = yield* ProviderEventLoggers;
  const retryRequested = yield* Queue.sliding<void>(1);

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const closeProviderLogWritersRequired = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    Effect.all(
      [providerEventLoggers.native, providerEventLoggers.canonical].flatMap((logger) =>
        logger?.closeThread ? [logger.closeThread(threadId)] : [],
      ),
      { discard: true },
    );

  const closeProviderLogWriters = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: closeProviderLogWritersRequired(threadId),
      message: "thread lifecycle cleanup skipped provider log writer close",
      threadId,
    });

  const stopArchiveProviderSession = Effect.fn("stopArchiveProviderSession")(function* (
    threadId: ThreadArchivedEvent["payload"]["threadId"],
  ) {
    const binding = yield* providerSessionDirectory.getBinding(threadId);
    if (Option.isSome(binding)) {
      yield* providerService.stopSession({ threadId });
      return;
    }

    const projectedSession = yield* projectionThreadSessions.getByThreadId({ threadId });
    const status = Option.isSome(projectedSession) ? projectedSession.value.status : null;
    if (status === "starting" || status === "running") {
      // The projection still permits an active writer. Keep failing closed and
      // let durable lifecycle recovery retry after the provider binding appears.
      yield* providerService.stopSession({ threadId });
      return;
    }

    yield* Effect.logDebug("archive cleanup found no provider binding for a settled thread", {
      threadId,
      projectedSessionStatus: status,
    });
  });

  const processLifecycleJob = Effect.fn("processThreadLifecycleJob")(function* (
    job: ThreadLifecycleJob,
  ) {
    if (job.type === "compact-legacy-storage") {
      yield* threadColdStorage.compactLegacyStorage;
      return;
    }
    const { threadId } = job;
    if (job.type === "archive") {
      // Archiving must not snapshot or delete hot rows while any active writer
      // can still mutate them. A failure leaves the durable archived shell or
      // manifest discoverable so startup recovery can retry the boundary.
      yield* stopArchiveProviderSession(threadId);
      yield* terminalManager.close({ threadId, deleteHistory: true });
      yield* closeProviderLogWritersRequired(threadId);
      yield* threadColdStorage.archiveThread(threadId);
      return;
    }
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* closeProviderLogWriters(threadId);
    yield* threadColdStorage.deleteThread(threadId);
  });

  const processLifecycleJobSafely = (job: ThreadLifecycleJob) =>
    processLifecycleJob(job).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread lifecycle reactor failed to process job", {
          lifecycleAction: job.type,
          ...(job.type === "compact-legacy-storage" ? {} : { threadId: job.threadId }),
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(Queue.offer(retryRequested, undefined)), Effect.asVoid);
      }),
    );

  const scheduledJobs = new Set<string>();
  const worker = yield* makeDrainableWorker((job: ThreadLifecycleJob) =>
    processLifecycleJobSafely(job).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          scheduledJobs.delete(lifecycleJobKey(job));
        }),
      ),
    ),
  );

  const enqueueLifecycleJob = (job: ThreadLifecycleJob) =>
    Effect.suspend(() => {
      const key = lifecycleJobKey(job);
      if (scheduledJobs.has(key)) return Effect.void;
      scheduledJobs.add(key);
      return worker.enqueue(job);
    });

  const enqueuePendingLifecycleJobs = Effect.fn("enqueuePendingThreadLifecycleJobs")(function* () {
    const pendingJobs = yield* Effect.all([
      threadColdStorage.listPendingDeleteThreadIds,
      threadColdStorage.listPendingArchiveThreadIds,
    ]).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to read pending thread storage migrations", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(Queue.offer(retryRequested, undefined)), Effect.as(null)),
      ),
    );
    if (pendingJobs === null) return;
    const [pendingDeletes, pendingArchives] = pendingJobs;
    yield* Effect.forEach(
      pendingDeletes,
      (threadId) => enqueueLifecycleJob({ type: "delete", threadId }),
      { discard: true },
    );
    yield* Effect.forEach(
      pendingArchives,
      (threadId) => enqueueLifecycleJob({ type: "archive", threadId }),
      { discard: true },
    );
  });

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.deleted") {
          return enqueueLifecycleJob({ type: "delete", threadId: event.payload.threadId });
        }
        if (event.type === "thread.archived") {
          return enqueueLifecycleJob({ type: "archive", threadId: event.payload.threadId });
        }
        return Effect.void;
      }),
    );

    yield* Queue.take(retryRequested).pipe(
      Effect.andThen(Effect.sleep(THREAD_LIFECYCLE_RETRY_DELAY)),
      Effect.andThen(enqueuePendingLifecycleJobs()),
      Effect.andThen(enqueueLifecycleJob({ type: "compact-legacy-storage" })),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* enqueuePendingLifecycleJobs();
    yield* enqueueLifecycleJob({ type: "compact-legacy-storage" });
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
