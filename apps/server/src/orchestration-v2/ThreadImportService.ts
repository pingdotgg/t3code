import {
  CommandId,
  EventId,
  threadMoveMessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2LinkOrigin,
  type OrchestratorMcpThreadImportInput,
  type OrchestratorMcpThreadImportResult,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EventSink from "./EventSink.ts";
import * as ImportedHistory from "./importedHistory.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const IMPORT_EVENT_PREFIX = "thread-import:v1";

/** The imported thread's events could not be written. */
export class ThreadImportWriteError extends Schema.TaggedError<ThreadImportWriteError>()(
  "ThreadImportWriteError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "The thread could not be imported.";
  }
}

/** A retried import named another project than the one the thread landed in. */
export class ThreadImportProjectMismatchError extends Schema.TaggedError<ThreadImportProjectMismatchError>()(
  "ThreadImportProjectMismatchError",
  { threadId: ThreadId, existingProjectId: ProjectId },
) {
  override get message(): string {
    return `This handoff was already imported into another project (${this.existingProjectId}).`;
  }
}

/**
 * The thread was imported, but its continuation prompt could not start a run.
 * `rejection` is the orchestrator's own reason when it refused the message.
 */
export class ThreadImportContinuationError extends Schema.TaggedError<ThreadImportContinuationError>()(
  "ThreadImportContinuationError",
  { threadId: ThreadId, rejection: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.rejection === undefined
      ? "The thread was imported, but its first message could not start."
      : `The thread was imported, but its first message could not start: ${this.rejection}`;
  }
}

export type ThreadImportError =
  | ThreadImportWriteError
  | ThreadImportProjectMismatchError
  | ThreadImportContinuationError;

/** A checkout an import prepared for its thread. */
export interface ImportedWorkspace {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly undo: Effect.Effect<void>;
}

/**
 * Creates a thread here from another environment's conversation. Its history is run-less and
 * marked imported, so the first run gets it as context whatever the provider. Ids derive from
 * the source thread and the handoff, so a retried import returns the first one's thread.
 */
export class ThreadImportService extends Context.Service<
  ThreadImportService,
  {
    readonly importThread: <E = never>(
      input: OrchestratorMcpThreadImportInput & {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
        /** Prepares the thread's checkout, only when this import creates the thread. */
        readonly workspace?: Effect.Effect<ImportedWorkspace, E>;
      },
    ) => Effect.Effect<OrchestratorMcpThreadImportResult, ThreadImportError | E>;
  }
>()("t3/orchestration-v2/ThreadImportService") {}

const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Digest.Digest;

  /** The thread an import of `source` creates here, the same on every retry. */
  const importedThreadId = (source: OrchestratorMcpThreadImportInput["source"]) =>
    crypto
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          `${source.environmentId}\n${source.threadId}\n${source.handoffId}`,
        ),
      )
      .pipe(
        Effect.map((digest) => ThreadId.make(`thread:import:${Hex.encode(digest).slice(0, 32)}`)),
        Effect.orDie,
      );

  const historyEvents = (
    threadId: ThreadId,
    messages: OrchestratorMcpThreadImportInput["messages"],
  ): ReadonlyArray<OrchestrationV2DomainEvent> =>
    messages.flatMap((message, index) =>
      ImportedHistory.importedMessageEvents({
        prefix: IMPORT_EVENT_PREFIX,
        threadId,
        index,
        message,
      }),
    );

  const importThread: ThreadImportService["Service"]["importThread"] = Effect.fn(
    "ThreadImportService.importThread",
  )(function* (input) {
    const threadId = yield* importedThreadId(input.source);
    const existing = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    let created = false;
    if (existing === null) {
      const workspace = input.workspace === undefined ? undefined : yield* input.workspace;
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        createdBy: "agent",
        creationSource: "mcp",
        id: threadId,
        projectId: input.projectId,
        title: input.title,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: workspace === undefined ? (input.branch ?? null) : workspace.branch,
        worktreePath:
          workspace === undefined ? (input.worktreePath ?? null) : workspace.worktreePath,
        linkedPullRequest: null,
        branchPullRequest: null,
        activeProviderThreadId: null,
        historyOrigin: "v1_import",
        ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* sink
        .write({
          events: [
            {
              id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
              type: "thread.created",
              threadId,
              providerInstanceId: input.modelSelection.instanceId,
              occurredAt: now,
              payload: thread,
            },
            ...historyEvents(threadId, input.messages),
          ],
        })
        .pipe(
          // A concurrent retry may have written the same events first.
          Effect.catchCause((cause) =>
            threads.getThreadShell(threadId).pipe(
              Effect.orElseSucceed(() => null),
              Effect.flatMap((raced) => (raced === null ? Effect.failCause(cause) : Effect.void)),
            ),
          ),
          // The checkout was made for a thread that now does not exist.
          Effect.tapError(() => workspace?.undo ?? Effect.void),
          Effect.mapError((cause) => new ThreadImportWriteError({ threadId, cause })),
        );
      created = true;
    } else if (existing.projectId !== input.projectId) {
      return yield* new ThreadImportProjectMismatchError({
        threadId,
        existingProjectId: existing.projectId,
      });
    }
    const runId = yield* startContinuation(threadId, input);
    return { threadId, projectId: input.projectId, created, runId };
  });

  /** Sends the continuation prompt once; a retry replays the same command. */
  const startContinuation = (
    threadId: ThreadId,
    input: OrchestratorMcpThreadImportInput,
  ): Effect.Effect<RunId | null, ThreadImportContinuationError> =>
    input.continuationPrompt === undefined
      ? Effect.succeed(null)
      : threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:thread-import:${threadId}:continue`),
            threadId,
            messageId: threadMoveMessageId(threadId),
            // Names where the thread came from; clients draw this message as the move's divider.
            linkedSender: {
              environmentId: input.source.environmentId,
              threadId: input.source.threadId,
              title: input.title,
            },
            text: input.continuationPrompt,
            attachments: [],
            modelSelection: input.modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.flatMap(() => threads.getThreadRecords(threadId, ["runs"])),
            Effect.map((records) => Option.fromNullishOr(records.runs.at(-1)?.id)),
            Effect.map(Option.getOrNull),
            Effect.mapError(
              (cause) =>
                new ThreadImportContinuationError({
                  threadId,
                  // Decider refusals are public; storage and other causes are not.
                  ...((cause._tag === "OrchestratorDispatchError" ||
                    cause._tag === "OrchestratorCommandRejectedError") &&
                  typeof cause.cause === "string" &&
                  cause.cause.length > 0
                    ? { rejection: Array.from(cause.cause).slice(0, 1000).join("") }
                    : {}),
                  cause,
                }),
            ),
          );

  return ThreadImportService.of({ importThread });
});

export const layer = Layer.effect(ThreadImportService, make);
