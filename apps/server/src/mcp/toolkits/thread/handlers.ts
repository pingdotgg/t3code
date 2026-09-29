import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadArchiveFailedError, ThreadNotFoundError, ThreadToolkit } from "./tools.ts";

/** How long a deferred archive waits for the calling turn to end. */
const DEFERRED_ARCHIVE_TIMEOUT = "1 hour";

type DeferredArchiveStep = "archive" | "cancel" | "wait";

/** The turn ended with nothing after it, a new turn took over, or it is still running. */
function stepForActiveTurn(activeTurnId: TurnId | null, turnId: TurnId): DeferredArchiveStep {
  if (activeTurnId === turnId) return "wait";
  return activeTurnId === null ? "archive" : "cancel";
}

function stepForShell(
  thread: Option.Option<OrchestrationThreadShell>,
  turnId: TurnId,
): DeferredArchiveStep {
  if (Option.isNone(thread) || thread.value.archivedAt !== null) return "cancel";
  return stepForActiveTurn(thread.value.session?.activeTurnId ?? null, turnId);
}

function stepForEvent(
  event: OrchestrationEvent,
  threadId: ThreadId,
  turnId: TurnId,
): DeferredArchiveStep {
  if (event.aggregateKind !== "thread" || event.aggregateId !== threadId) return "wait";
  switch (event.type) {
    case "thread.session-set":
      return stepForActiveTurn(event.payload.session.activeTurnId, turnId);
    case "thread.archived":
    case "thread.deleted":
      return "cancel";
    default:
      return "wait";
  }
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  // Deferred archives outlive the tool call, not the server.
  const lifetime = yield* Scope.Scope;

  /** Succeeds with false when the thread was already archived by the time the command ran. */
  const archive = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`server:mcp-thread-archive:${threadId}:${uuid}`),
        threadId,
      });
    }).pipe(
      Effect.as(true),
      Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.succeed(false) }),
    );

  const archiveAfterTurn = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      // Subscribe before reading, so a turn that ends in between is still seen.
      const events = yield* engine.subscribeDomainEvents;
      let step = stepForShell(yield* snapshots.getThreadShellById(threadId), turnId);
      if (step === "wait") {
        const next = yield* events.pipe(
          Stream.map((event) => stepForEvent(event, threadId, turnId)),
          Stream.filter((candidate) => candidate !== "wait"),
          Stream.runHead,
        );
        step = Option.getOrElse(next, () => "cancel" as const);
      }
      if (step === "archive") yield* archive(threadId);
    }).pipe(
      Effect.scoped,
      Effect.timeout(DEFERRED_ARCHIVE_TIMEOUT),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("deferred MCP thread archive failed", {
            threadId,
            turnId,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  return ThreadToolkit.of({
    archive_thread: () =>
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.requireMcpCapability("thread");
        const shell = yield* snapshots
          .getThreadShellById(invocation.threadId)
          .pipe(Effect.mapError((cause) => new ThreadArchiveFailedError({ cause })));
        if (Option.isNone(shell)) {
          return yield* new ThreadNotFoundError({ threadId: invocation.threadId });
        }
        const thread = shell.value;
        if (thread.archivedAt !== null) {
          return { threadId: thread.id, alreadyArchived: true, scheduled: false };
        }
        const turnId = thread.session?.activeTurnId ?? null;
        if (turnId === null) {
          const archived = yield* archive(thread.id).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(new ThreadArchiveFailedError({ cause })),
            ),
          );
          return { threadId: thread.id, alreadyArchived: !archived, scheduled: false };
        }
        // Provider ingestion skips archived threads, so archiving now would drop the rest
        // of this turn (its final message and the session returning to ready) and leave
        // the thread looking busy. Archive once the turn has ended instead.
        yield* Effect.forkIn(archiveAfterTurn(thread.id, turnId), lifetime);
        return { threadId: thread.id, alreadyArchived: false, scheduled: true };
      }),
  });
});

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer(make);
