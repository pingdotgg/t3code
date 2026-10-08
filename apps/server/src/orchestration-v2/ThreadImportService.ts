import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2LinkOrigin,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadImportInput,
  type OrchestratorMcpThreadImportResult,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EventSink from "./EventSink.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const IMPORT_EVENT_PREFIX = "thread-import:v1";

/**
 * Creates a thread here seeded with a conversation from another environment,
 * for a thread moving here. The history is runless and marked as imported,
 * so the first run gets it as a text context handoff, whatever the provider.
 * Every id derives from the source thread and the handoff, so retrying an
 * import returns the thread the first one created.
 */
export class ThreadImportService extends Context.Service<
  ThreadImportService,
  {
    readonly importThread: (
      input: OrchestratorMcpThreadImportInput & {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
        /**
         * Prepares the checkout the thread works in, run only when this import
         * creates the thread; `undo` runs if the thread then cannot be written.
         */
        readonly workspace?: Effect.Effect<ImportedWorkspace, OrchestratorMcpFailure>;
      },
    ) => Effect.Effect<OrchestratorMcpThreadImportResult, OrchestratorMcpFailure>;
  }
>()("t3/orchestration-v2/ThreadImportService") {}

/** A checkout an import prepared for its thread. */
export interface ImportedWorkspace {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly undo: Effect.Effect<void>;
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  /** The thread an import of `source` creates here, the same on every retry. */
  const importedThreadId = (source: OrchestratorMcpThreadImportInput["source"]) =>
    crypto
      .digest(
        "SHA-256",
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
    messages.flatMap((message, index) => {
      const suffix = String(index).padStart(6, "0");
      const messageId = MessageId.make(`${threadId}:${suffix}`);
      const turnItemId = TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`);
      const at = DateTime.makeUnsafe(message.createdAt);
      const common = {
        id: turnItemId,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // Imported items are numbered before any run here by the position store.
        ordinal: index + 1,
        status: "completed" as const,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      return [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${threadId}:${suffix}`),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            createdBy: message.role === "user" ? "user" : "agent",
            creationSource: "server",
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text: message.text,
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload:
            message.role === "user"
              ? {
                  ...common,
                  createdBy: "user",
                  creationSource: "server",
                  type: "user_message",
                  messageId,
                  inputIntent: "turn_start",
                  text: message.text,
                  attachments: [],
                }
              : {
                  ...common,
                  type: "assistant_message",
                  messageId,
                  text: message.text,
                  streaming: false,
                },
        },
      ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    });

  const importThread: ThreadImportService["Service"]["importThread"] = (input) =>
    Effect.gen(function* () {
      const threadId = yield* importedThreadId(input.source);
      const existing = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
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
          snoozedUntil: null,
          snoozedAt: null,
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
            Effect.tapError(() => workspace?.undo ?? Effect.void),
            Effect.mapError(() =>
              failure("orchestration_error", "The thread could not be imported."),
            ),
          );
        created = true;
      } else if (existing.projectId !== input.projectId) {
        return yield* failure(
          "invalid_request",
          `This handoff was already imported into another project (${existing.projectId}).`,
        );
      }
      const runId = yield* startContinuation(threadId, input);
      return { threadId, projectId: input.projectId, created, runId };
    });

  /** Sends the continuation prompt once; a retry replays the same command. */
  const startContinuation = (
    threadId: ThreadId,
    input: OrchestratorMcpThreadImportInput,
  ): Effect.Effect<RunId | null, OrchestratorMcpFailure> =>
    input.continuationPrompt === undefined
      ? Effect.succeed(null)
      : threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:thread-import:${threadId}:continue`),
            threadId,
            messageId: MessageId.make(`${threadId}:continue`),
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
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `The thread was imported, but its first message could not start: ${error.message}`,
              ),
            ),
          );

  return ThreadImportService.of({ importThread });
});

export const layer = Layer.effect(ThreadImportService, make);
