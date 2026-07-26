import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadArchiveReactor,
  type ThreadArchiveReactorShape,
} from "../Services/ThreadArchiveReactor.ts";
import {
  interruptTurnIfSessionActive,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;

  // Stop the provider session through the command pipeline (rather than a
  // direct providerService.stopSession call) so ProviderCommandReactor also
  // marks the projection session stopped — archived threads stay visible in
  // the archived shell and must not read as still running. Gated on the
  // session directory because the projection shell lookup omits archived
  // threads by the time this reactor sees the event.
  const stopSessionIfActive = (event: ThreadArchivedEvent) => {
    const { threadId } = event.payload;
    return logCleanupCauseUnlessInterrupted({
      effect: Effect.gen(function* () {
        const binding = yield* directory.getBinding(threadId);
        const status = Option.match(binding, {
          onNone: () => undefined,
          onSome: (entry) => entry.status,
        });
        if (status === undefined || status === "stopped") {
          return;
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(`session-stop-for-archive:${event.commandId}`),
            threadId,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.asVoid);
      }),
      message: "thread archive cleanup skipped provider session stop",
      threadId,
    });
  };

  const closeThreadTerminals = (threadId: ThreadArchivedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId }),
      message: "thread archive cleanup skipped terminal close",
      threadId,
    });

  // Cascade archive to child threads (sub-agents). The cascade recurses
  // through the child `thread.archived` events emitted by these dispatches.
  // Loop safety: already-archived children are skipped here and rejected by
  // the decider's requireThreadNotArchived, and the parent graph cannot
  // contain cycles (enforced at thread.create).
  const cascadeArchiveChildren = (event: ThreadArchivedEvent) => {
    const { threadId } = event.payload;
    return logCleanupCauseUnlessInterrupted({
      effect: Effect.gen(function* () {
        const childRefs = yield* projectionSnapshotQuery.listChildThreadRefs(threadId);
        yield* Effect.forEach(childRefs, (childRef) => {
          if (childRef.archived) {
            return Effect.void;
          }
          return logCleanupCauseUnlessInterrupted({
            effect: orchestrationEngine
              .dispatch({
                type: "thread.archive",
                commandId: CommandId.make(
                  `archive-cascade:${event.commandId}:${childRef.threadId}`,
                ),
                threadId: childRef.threadId,
              })
              .pipe(Effect.asVoid),
            message: "thread archive cleanup skipped child thread archive",
            threadId: childRef.threadId,
          });
        });
      }),
      message: "thread archive cleanup skipped child thread archive cascade",
      threadId,
    });
  };

  const processThreadArchived = Effect.fn("processThreadArchived")(function* (
    event: ThreadArchivedEvent,
  ) {
    const { threadId } = event.payload;
    // Graceful interrupt first so the provider can wind the active turn down
    // before the session process is torn down.
    yield* interruptTurnIfSessionActive({
      threadId,
      message: "thread archive cleanup skipped turn interrupt",
    });
    yield* stopSessionIfActive(event);
    yield* closeThreadTerminals(threadId);
    yield* cascadeArchiveChildren(event);
  });

  const processThreadArchivedSafely = (event: ThreadArchivedEvent) =>
    processThreadArchived(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread archive reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadArchivedSafely);

  const start: ThreadArchiveReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.archived") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadArchiveReactorShape;
});

export const ThreadArchiveReactorLive = Layer.effect(ThreadArchiveReactor, make);
