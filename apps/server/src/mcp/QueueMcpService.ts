import {
  CommandId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  QueueMcpFailure,
  type QueueMcpCancelInput,
  type QueueMcpCancelResult,
  type QueueMcpEditInput,
  type QueueMcpEditResult,
  type QueueMcpListInput,
  type QueueMcpListResult,
  type QueueMcpPromoteInput,
  type QueueMcpPromoteResult,
  type QueueMcpQueuedRun,
  type QueueMcpReadInput,
  type QueueMcpReadResult,
  type QueueMcpReorderInput,
  type QueueMcpReorderResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_MESSAGE_CHARS = 2_000;
const DEFAULT_READ_MESSAGE_CHARS = 120_000;

export interface QueueMcpServiceShape {
  readonly list: (
    scope: McpInvocationScope,
    input: QueueMcpListInput,
  ) => Effect.Effect<QueueMcpListResult, QueueMcpFailure>;
  readonly read: (
    scope: McpInvocationScope,
    input: QueueMcpReadInput,
  ) => Effect.Effect<QueueMcpReadResult, QueueMcpFailure>;
  readonly edit: (
    scope: McpInvocationScope,
    input: QueueMcpEditInput,
  ) => Effect.Effect<QueueMcpEditResult, QueueMcpFailure>;
  readonly reorder: (
    scope: McpInvocationScope,
    input: QueueMcpReorderInput,
  ) => Effect.Effect<QueueMcpReorderResult, QueueMcpFailure>;
  readonly cancel: (
    scope: McpInvocationScope,
    input: QueueMcpCancelInput,
  ) => Effect.Effect<QueueMcpCancelResult, QueueMcpFailure>;
  readonly promote: (
    scope: McpInvocationScope,
    input: QueueMcpPromoteInput,
  ) => Effect.Effect<QueueMcpPromoteResult, QueueMcpFailure>;
}

export class QueueMcpService extends Context.Service<QueueMcpService, QueueMcpServiceShape>()(
  "t3/mcp/QueueMcpService",
) {}

function failure(code: QueueMcpFailure["code"], message: string): QueueMcpFailure {
  return new QueueMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    return String((error as { readonly detail: unknown }).detail);
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { readonly cause: unknown }).cause;
    if (typeof cause === "string") return cause;
    if (cause instanceof Error) return cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function dispatchFailure(error: unknown): QueueMcpFailure {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { readonly _tag: unknown })._tag)
      : "";
  return tag === "OrchestratorDispatchError" || tag === "OrchestratorCommandPreviouslyRejectedError"
    ? failure("operation_rejected", errorMessage(error))
    : failure("orchestration_error", errorMessage(error));
}

function truncate(text: string, maxChars: number) {
  return text.length <= maxChars
    ? { text, textTruncated: false as const }
    : { text: `${text.slice(0, maxChars)}\n…[truncated]`, textTruncated: true as const };
}

function queuedRunSummary(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly run: ReturnType<typeof queuedRunsInDeliveryOrder>[number];
  readonly message: OrchestrationV2ConversationMessage;
  readonly queuePosition: number;
  readonly maxChars: number;
}): QueueMcpQueuedRun {
  return {
    projectId: input.projection.thread.projectId,
    threadId: input.projection.thread.id,
    queuedRunId: input.run.id,
    messageId: input.message.id,
    queuePosition: input.queuePosition,
    ordinal: input.run.ordinal,
    providerInstanceId: input.run.modelSelection.instanceId,
    model: input.run.modelSelection.model,
    requestedAt: DateTime.formatIso(input.run.requestedAt),
    ...truncate(input.message.text, input.maxChars),
    attachments: input.message.attachments,
    automaticCompletion: input.message.delegatedCompletion !== undefined,
  };
}

function findQueuedRun(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): Effect.Effect<
  {
    readonly run: ReturnType<typeof queuedRunsInDeliveryOrder>[number];
    readonly message: OrchestrationV2ConversationMessage;
    readonly queuePosition: number;
  },
  QueueMcpFailure
> {
  const ordered = queuedRunsInDeliveryOrder(projection);
  const index = ordered.findIndex((run) => run.id === runId);
  const run = ordered[index];
  if (run === undefined) {
    return Effect.fail(
      failure(
        "queued_run_not_found",
        `Run '${runId}' is not queued in thread '${projection.thread.id}'.`,
      ),
    );
  }
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return message === undefined
    ? Effect.fail(
        failure(
          "orchestration_error",
          `Queued run '${runId}' has no durable user message '${run.userMessageId}'.`,
        ),
      )
    : Effect.succeed({ run, message, queuePosition: index + 1 });
}

function findRunMessage(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): Effect.Effect<
  {
    readonly run: OrchestrationV2ThreadProjection["runs"][number];
    readonly message: OrchestrationV2ConversationMessage;
  },
  QueueMcpFailure
> {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    return Effect.fail(
      failure(
        "queued_run_not_found",
        `Run '${runId}' was not found in thread '${projection.thread.id}'.`,
      ),
    );
  }
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return message === undefined
    ? Effect.fail(
        failure(
          "orchestration_error",
          `Run '${runId}' has no durable user message '${run.userMessageId}'.`,
        ),
      )
    : Effect.succeed({ run, message });
}

function stablePart(value: string): Effect.Effect<string, QueueMcpFailure> {
  try {
    return Effect.succeed(encodeURIComponent(value));
  } catch {
    return Effect.fail(
      failure(
        "invalid_request",
        "clientRequestId contains invalid Unicode and cannot be used for retry identity.",
      ),
    );
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId) =>
    threadManagement.getThreadProjection(threadId).pipe(
      Effect.mapError(() => failure("thread_not_found", `Thread '${threadId}' was not found.`)),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${threadId}' was not found.`),
      ),
    );

  const loadScopedThread = (scope: McpInvocationScope, requestedThreadId: ThreadId | undefined) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parent = yield* loadProjection(scope.threadId);
      const threadId = requestedThreadId ?? scope.threadId;
      if (threadId === scope.threadId) return parent;
      return yield* threadManagement
        .getProjectThread({ projectId: parent.thread.projectId, threadId })
        .pipe(
          Effect.mapError(() =>
            failure(
              "thread_not_found",
              `Thread '${threadId}' was not found in project '${parent.thread.projectId}'.`,
            ),
          ),
        );
    });

  const commandId = (input: {
    readonly scope: McpInvocationScope;
    readonly clientRequestId: string | undefined;
    readonly operation: string;
    readonly threadId: ThreadId;
    readonly queuedRunId: RunId;
  }) =>
    Effect.gen(function* () {
      const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const parts = yield* Effect.all(
        [
          input.scope.providerSessionId,
          input.operation,
          input.threadId,
          input.queuedRunId,
          requestKey,
        ].map(stablePart),
      );
      return CommandId.make(["command", "mcp", "queue", ...parts].join(":"));
    });

  return QueueMcpService.of({
    list: (scope, input) =>
      Effect.gen(function* () {
        const projection = yield* loadScopedThread(scope, input.threadId);
        const ordered = queuedRunsInDeliveryOrder(projection);
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? DEFAULT_LIST_LIMIT;
        const maxChars = input.maxCharsPerMessage ?? DEFAULT_LIST_MESSAGE_CHARS;
        const page = ordered.slice(cursor, cursor + limit);
        const messages = new Map(projection.messages.map((message) => [message.id, message]));
        const runs = yield* Effect.forEach(page, (run, index) => {
          const message = messages.get(run.userMessageId);
          return message === undefined
            ? Effect.fail(
                failure(
                  "orchestration_error",
                  `Queued run '${run.id}' has no durable user message '${run.userMessageId}'.`,
                ),
              )
            : Effect.succeed(
                queuedRunSummary({
                  projection,
                  run,
                  message,
                  queuePosition: cursor + index + 1,
                  maxChars,
                }),
              );
        });
        return {
          projectId: projection.thread.projectId,
          threadId: projection.thread.id,
          runs,
          nextCursor: cursor + page.length < ordered.length ? cursor + page.length : null,
          total: ordered.length,
        } satisfies QueueMcpListResult;
      }),
    read: (scope, input) =>
      Effect.gen(function* () {
        const projection = yield* loadScopedThread(scope, input.threadId);
        const queued = yield* findQueuedRun(projection, input.queuedRunId);
        return queuedRunSummary({
          projection,
          ...queued,
          maxChars: input.maxChars ?? DEFAULT_READ_MESSAGE_CHARS,
        }) satisfies QueueMcpReadResult;
      }),
    edit: (scope, input) =>
      Effect.gen(function* () {
        const projection = yield* loadScopedThread(scope, input.threadId);
        const queued = yield* findRunMessage(projection, input.queuedRunId);
        const requestedAttachmentIds = input.attachmentIds;
        const attachments =
          requestedAttachmentIds === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const uniqueIds = new Set(requestedAttachmentIds);
                if (uniqueIds.size !== requestedAttachmentIds.length) {
                  return yield* failure(
                    "invalid_request",
                    "attachmentIds must not contain duplicates.",
                  );
                }
                const owned = new Map(
                  projection.messages
                    .flatMap((message) => message.attachments)
                    .map((item) => [item.id, item]),
                );
                return yield* Effect.forEach(requestedAttachmentIds, (id) => {
                  const attachment = owned.get(id);
                  return attachment === undefined
                    ? Effect.fail(
                        failure(
                          "attachment_not_found",
                          `Attachment '${id}' is not owned by thread '${projection.thread.id}'.`,
                        ),
                      )
                    : Effect.succeed(attachment);
                });
              });
        const id = yield* commandId({
          scope,
          clientRequestId: input.clientRequestId,
          operation: "edit",
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
        });
        const receipt = yield* threadManagement
          .dispatch({
            type: "queued-run.edit",
            commandId: id,
            threadId: projection.thread.id,
            runId: input.queuedRunId,
            text: input.text,
            ...(attachments === undefined ? {} : { attachments }),
          })
          .pipe(Effect.mapError(dispatchFailure));
        const editedMessage = receipt.storedEvents.find(
          (stored) =>
            stored.event.type === "message.updated" &&
            stored.event.payload.id === queued.message.id,
        );
        const resultMessage =
          editedMessage?.event.type === "message.updated"
            ? editedMessage.event.payload
            : queued.message;
        return {
          commandId: id,
          receiptSequence: receipt.sequence,
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
          messageId: queued.message.id,
          text: resultMessage.text,
          attachments: resultMessage.attachments,
        } satisfies QueueMcpEditResult;
      }),
    reorder: (scope, input) =>
      Effect.gen(function* () {
        const projection = yield* loadScopedThread(scope, input.threadId);
        const id = yield* commandId({
          scope,
          clientRequestId: input.clientRequestId,
          operation: "reorder",
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
        });
        const receipt = yield* threadManagement
          .dispatch({
            type: "queued-run.reorder",
            commandId: id,
            threadId: projection.thread.id,
            runId: input.queuedRunId,
            beforeRunId: input.beforeRunId,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return {
          commandId: id,
          receiptSequence: receipt.sequence,
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
          beforeRunId: input.beforeRunId,
        } satisfies QueueMcpReorderResult;
      }),
    cancel: (scope, input) =>
      Effect.gen(function* () {
        const projection = yield* loadScopedThread(scope, input.threadId);
        const id = yield* commandId({
          scope,
          clientRequestId: input.clientRequestId,
          operation: "cancel",
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
        });
        const receipt = yield* threadManagement
          .dispatch({
            type: "queued-run.cancel",
            commandId: id,
            threadId: projection.thread.id,
            runId: input.queuedRunId,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return {
          commandId: id,
          receiptSequence: receipt.sequence,
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
          status: "cancelled",
        } satisfies QueueMcpCancelResult;
      }),
    promote: (scope, input) =>
      Effect.gen(function* () {
        const projection = yield* loadScopedThread(scope, input.threadId);
        const id = yield* commandId({
          scope,
          clientRequestId: input.clientRequestId,
          operation: `promote:${input.targetRunId}`,
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
        });
        const receipt = yield* threadManagement
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: id,
            threadId: projection.thread.id,
            queuedRunId: input.queuedRunId,
            targetRunId: input.targetRunId,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return {
          commandId: id,
          receiptSequence: receipt.sequence,
          threadId: projection.thread.id,
          queuedRunId: input.queuedRunId,
          targetRunId: input.targetRunId,
          status: "promoted",
        } satisfies QueueMcpPromoteResult;
      }),
  });
});

export const layer: Layer.Layer<QueueMcpService, never, Crypto.Crypto | ThreadManagementService> =
  Layer.effect(QueueMcpService, make);
