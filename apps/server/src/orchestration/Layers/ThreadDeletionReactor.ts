import { CommandId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

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

/**
 * Best-effort graceful turn interrupt before a session teardown. Gated on the
 * session directory (not the projection, which omits archived/deleted threads)
 * so `interruptTurn` never recovers — and thereby respawns — a provider
 * process for a session that is already stopped.
 */
export const interruptTurnIfSessionActive = ({
  threadId,
  message,
}: {
  readonly threadId: ThreadId;
  readonly message: string;
}) =>
  logCleanupCauseUnlessInterrupted({
    effect: Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const providerService = yield* ProviderService;
      const binding = yield* directory.getBinding(threadId);
      const status = Option.match(binding, {
        onNone: () => undefined,
        onSome: (entry) => entry.status,
      });
      if (status !== "starting" && status !== "running") {
        return;
      }
      yield* providerService.interruptTurn({ threadId });
    }),
    message,
    threadId,
  });

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

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

  // Cascade deletion to child threads (sub-agents) so no child session,
  // terminal, or deeper descendant survives the parent's deletion. The
  // cascade recurses through the child `thread.deleted` events emitted by
  // these dispatches. Loop safety: `listChildThreadRefs` only returns
  // non-deleted children, so an already-deleted child is never re-dispatched,
  // and the parent graph cannot contain cycles (enforced at thread.create).
  const cascadeDeleteChildren = (event: ThreadDeletedEvent) => {
    const { threadId } = event.payload;
    return logCleanupCauseUnlessInterrupted({
      effect: Effect.gen(function* () {
        const childRefs = yield* projectionSnapshotQuery.listChildThreadRefs(threadId);
        yield* Effect.forEach(childRefs, (childRef) =>
          logCleanupCauseUnlessInterrupted({
            effect: orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`delete-cascade:${event.commandId}:${childRef.threadId}`),
                threadId: childRef.threadId,
              })
              .pipe(Effect.asVoid),
            message: "thread deletion cleanup skipped child thread delete",
            threadId: childRef.threadId,
          }),
        );
      }),
      message: "thread deletion cleanup skipped child thread delete cascade",
      threadId,
    });
  };

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    // Graceful interrupt first so the provider can wind the active turn down
    // before the session process is torn down.
    yield* interruptTurnIfSessionActive({
      threadId,
      message: "thread deletion cleanup skipped turn interrupt",
    });
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* cascadeDeleteChildren(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
