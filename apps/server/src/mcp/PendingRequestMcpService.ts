import {
  CommandId,
  PENDING_REQUEST_MCP_MAX_HEADER_CHARS,
  PENDING_REQUEST_MCP_MAX_OPTION_DESCRIPTION_CHARS,
  PENDING_REQUEST_MCP_MAX_OPTION_LABEL_CHARS,
  PENDING_REQUEST_MCP_MAX_OPTIONS_PER_QUESTION,
  PENDING_REQUEST_MCP_MAX_QUESTION_CHARS,
  PENDING_REQUEST_MCP_MAX_QUESTION_ID_CHARS,
  PENDING_REQUEST_MCP_MAX_QUESTIONS,
  PENDING_REQUEST_MCP_MAX_TOTAL_QUESTION_CHARS,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  PendingRequestMcpFailure,
  type PendingRequestMcpListInput,
  type PendingRequestMcpListResult,
  type PendingRequestMcpReadInput,
  type PendingRequestMcpReadResult,
  type PendingRequestMcpRequest,
  type PendingRequestMcpRespondInput,
  type PendingRequestMcpRespondResult,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  OrchestratorProjectionError,
  type OrchestratorV2Error,
} from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import {
  type ThreadManagementError,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { interactionModeWithinMcpCeiling, runtimeModeWithinMcpCeiling } from "./McpModeCeilings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_CHILD_PROJECTIONS = 20;

interface ListCursor {
  readonly taskId: string;
  readonly requestId: string | null;
}

function parseListCursor(
  cursor: string | undefined,
): Effect.Effect<ListCursor | null, PendingRequestMcpFailure> {
  if (cursor === undefined) return Effect.succeed(null);
  const match = /^v1:([^:]+):(.*)$/.exec(cursor);
  if (match === null) {
    return Effect.fail(failure("invalid_request", "The pending-request cursor is invalid."));
  }
  try {
    const taskId = decodeURIComponent(match[1] ?? "");
    const requestId = decodeURIComponent(match[2] ?? "");
    return taskId.length === 0
      ? Effect.fail(failure("invalid_request", "The pending-request cursor is invalid."))
      : Effect.succeed({ taskId, requestId: requestId.length === 0 ? null : requestId });
  } catch {
    return Effect.fail(failure("invalid_request", "The pending-request cursor is invalid."));
  }
}

function listCursor(taskId: string, requestId: string | null): string {
  return `v1:${encodeURIComponent(taskId)}:${requestId === null ? "" : encodeURIComponent(requestId)}`;
}

export class PendingRequestMcpService extends Context.Service<
  PendingRequestMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: PendingRequestMcpListInput,
    ) => Effect.Effect<PendingRequestMcpListResult, PendingRequestMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      input: PendingRequestMcpReadInput,
    ) => Effect.Effect<PendingRequestMcpReadResult, PendingRequestMcpFailure>;
    readonly respond: (
      scope: McpInvocationScope,
      input: PendingRequestMcpRespondInput,
    ) => Effect.Effect<PendingRequestMcpRespondResult, PendingRequestMcpFailure>;
  }
>()("t3/mcp/PendingRequestMcpService") {}

function failure(
  code: PendingRequestMcpFailure["code"],
  message: string,
): PendingRequestMcpFailure {
  return new PendingRequestMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isOrchestratorProjectionError = Schema.is(OrchestratorProjectionError);
const isProjectionStoreThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);

function isMissingChild(error: ThreadManagementError): boolean {
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return true;
    case "ThreadManagementProjectionLoadError":
      return (
        isOrchestratorProjectionError(error.cause) &&
        isProjectionStoreThreadNotFound(error.cause.cause)
      );
    case "ThreadManagementRunNotFoundError":
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
    case "ThreadManagementThreadNotInterruptibleError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return false;
  }
}

function projectionFailure(
  error: ThreadManagementError,
  threadId: ThreadId,
): PendingRequestMcpFailure {
  return isMissingChild(error)
    ? failure("child_not_found", `Delegated child thread '${threadId}' was not found.`)
    : failure(
        "orchestration_error",
        `Unable to load delegated child thread '${threadId}': ${errorMessage(error)}`,
      );
}

function dispatchFailure(error: OrchestratorV2Error): PendingRequestMcpFailure {
  switch (error._tag) {
    case "OrchestratorDispatchError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
      return failure("operation_rejected", error.message);
    default:
      return failure("orchestration_error", error.message);
  }
}

function directAppOwnedChildren(parent: OrchestrationV2ThreadProjection) {
  return parent.subagents
    .filter(
      (task): task is OrchestrationV2Subagent & { readonly childThreadId: ThreadId } =>
        task.origin === "app_owned" && task.childThreadId !== null,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function findUserInputItem(
  projection: OrchestrationV2ThreadProjection,
  requestId: RuntimeRequestId,
): Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }> | undefined {
  return projection.turnItems.find(
    (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }> =>
      item.type === "user_input_request" && item.requestId === requestId,
  );
}

function questionPayloadFits(
  questions: Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>["questions"],
): boolean {
  if (questions.length > PENDING_REQUEST_MCP_MAX_QUESTIONS) return false;
  let totalChars = 0;
  for (const question of questions) {
    if (
      question.id.length > PENDING_REQUEST_MCP_MAX_QUESTION_ID_CHARS ||
      question.header.length > PENDING_REQUEST_MCP_MAX_HEADER_CHARS ||
      question.question.length > PENDING_REQUEST_MCP_MAX_QUESTION_CHARS ||
      question.options.length > PENDING_REQUEST_MCP_MAX_OPTIONS_PER_QUESTION
    ) {
      return false;
    }
    totalChars += question.id.length + question.header.length + question.question.length;
    for (const option of question.options) {
      if (
        option.label.length > PENDING_REQUEST_MCP_MAX_OPTION_LABEL_CHARS ||
        option.description.length > PENDING_REQUEST_MCP_MAX_OPTION_DESCRIPTION_CHARS
      ) {
        return false;
      }
      totalChars += option.label.length + option.description.length;
    }
    if (totalChars > PENDING_REQUEST_MCP_MAX_TOTAL_QUESTION_CHARS) return false;
  }
  return true;
}

function requestSummary(input: {
  readonly task: OrchestrationV2Subagent & { readonly childThreadId: ThreadId };
  readonly projection: OrchestrationV2ThreadProjection;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>;
}): Effect.Effect<PendingRequestMcpRequest, PendingRequestMcpFailure> {
  const providerThread =
    input.item.providerThreadId === null
      ? undefined
      : input.projection.providerThreads.find(
          (candidate) => candidate.id === input.item.providerThreadId,
        );
  if (providerThread === undefined) {
    return Effect.fail(
      failure(
        "orchestration_error",
        `User-input request '${input.request.id}' has no durable provider thread.`,
      ),
    );
  }
  const payloadFits = questionPayloadFits(input.item.questions);
  return Effect.succeed({
    taskId: input.task.id,
    childThreadId: input.task.childThreadId,
    runId: input.item.runId,
    nodeId: input.request.nodeId,
    requestId: input.request.id,
    providerInstanceId: providerThread.providerInstanceId,
    driverKind: providerThread.driver,
    status: input.request.status,
    resumable: input.request.responseCapability.type === "live",
    answerable:
      input.request.status === "pending" &&
      input.request.responseCapability.type === "live" &&
      payloadFits,
    questionCount: input.item.questions.length,
    questionPayloadStatus: payloadFits ? "complete" : "too_large",
    questions: payloadFits ? input.item.questions : [],
    createdAt: DateTime.formatIso(input.request.createdAt),
    resolvedAt:
      input.request.resolvedAt === null ? null : DateTime.formatIso(input.request.resolvedAt),
  });
}

function stablePart(value: string): Effect.Effect<string, PendingRequestMcpFailure> {
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

export const make = Effect.gen(function* () {
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

  const loadParent = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parent = yield* threadManagement
        .getThreadProjection(scope.threadId)
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to load calling thread '${scope.threadId}': ${errorMessage(error)}`,
            ),
          ),
        );
      if (parent.thread.deletedAt !== null) {
        return yield* failure("child_not_found", "The calling thread is no longer active.");
      }
      return parent;
    });

  const loadChild = (parent: OrchestrationV2ThreadProjection, childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const task = directAppOwnedChildren(parent).find(
        (candidate) => candidate.childThreadId === childThreadId,
      );
      if (task === undefined) {
        return yield* failure(
          "child_not_found",
          `Thread '${childThreadId}' is not a direct app-owned delegated child of '${parent.thread.id}'.`,
        );
      }
      const projection = yield* threadManagement
        .getProjectThread({ projectId: parent.thread.projectId, threadId: childThreadId })
        .pipe(Effect.mapError((error) => projectionFailure(error, childThreadId)));
      return { task, projection } as const;
    });

  const findRequest = (input: {
    readonly task: OrchestrationV2Subagent & { readonly childThreadId: ThreadId };
    readonly projection: OrchestrationV2ThreadProjection;
    readonly requestId: RuntimeRequestId;
  }) =>
    Effect.gen(function* () {
      const request = input.projection.runtimeRequests.find(
        (candidate) => candidate.id === input.requestId,
      );
      if (request === undefined) {
        return yield* failure(
          "request_not_found",
          `Runtime request '${input.requestId}' was not found on delegated child '${input.task.childThreadId}'.`,
        );
      }
      if (request.kind !== "user_input") {
        return yield* failure(
          "wrong_request_kind",
          `Runtime request '${request.id}' is '${request.kind}', not a user-input question.`,
        );
      }
      const item = findUserInputItem(input.projection, request.id);
      if (item === undefined) {
        return yield* failure(
          "orchestration_error",
          `User-input request '${request.id}' has no durable question details.`,
        );
      }
      return { request, item } as const;
    });

  const commandId = (input: {
    readonly scope: McpInvocationScope;
    readonly childThreadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly clientRequestId: string | undefined;
  }) =>
    Effect.gen(function* () {
      const requestKey = input.clientRequestId ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const parts = yield* Effect.all(
        [input.scope.providerSessionId, input.childThreadId, input.requestId, requestKey].map(
          stablePart,
        ),
      );
      return CommandId.make(["command", "mcp", "pending-request", ...parts].join(":"));
    });

  const requireResponseCeiling = (
    caller: OrchestrationV2ThreadProjection,
    target: OrchestrationV2ThreadProjection,
  ) => {
    if (!runtimeModeWithinMcpCeiling(caller.thread.runtimeMode, target.thread.runtimeMode)) {
      return Effect.fail(
        failure(
          "runtime_mode_escalation_denied",
          `Target runtime mode ${target.thread.runtimeMode} is broader than caller mode ${caller.thread.runtimeMode}.`,
        ),
      );
    }
    return interactionModeWithinMcpCeiling(
      caller.thread.interactionMode,
      target.thread.interactionMode,
    )
      ? Effect.void
      : Effect.fail(
          failure(
            "interaction_mode_escalation_denied",
            `Target interaction mode ${target.thread.interactionMode} is broader than caller mode ${caller.thread.interactionMode}.`,
          ),
        );
  };

  const resultFor = (input: {
    readonly task: OrchestrationV2Subagent & { readonly childThreadId: ThreadId };
    readonly projection: OrchestrationV2ThreadProjection;
    readonly requestId: RuntimeRequestId;
  }) =>
    findRequest(input).pipe(
      Effect.flatMap(({ request, item }) =>
        requestSummary({ task: input.task, projection: input.projection, request, item }),
      ),
    );

  return PendingRequestMcpService.of({
    list: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadParent(scope);
        const children = directAppOwnedChildren(parent);
        const limit = input.limit ?? DEFAULT_LIST_LIMIT;
        const cursor = yield* parseListCursor(input.cursor);
        const requests: Array<PendingRequestMcpRequest> = [];
        let projectionCount = 0;
        let continuation: string | null = null;
        let lastScannedChildIndex = -1;

        for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
          const task = children[childIndex];
          if (task === undefined) break;
          const taskComparison = cursor === null ? 1 : task.id.localeCompare(cursor.taskId);
          if (taskComparison < 0 || (taskComparison === 0 && cursor?.requestId === null)) continue;
          if (projectionCount >= MAX_LIST_CHILD_PROJECTIONS) {
            break;
          }
          projectionCount += 1;
          lastScannedChildIndex = childIndex;
          const projection = yield* threadManagement
            .getProjectThread({
              projectId: parent.thread.projectId,
              threadId: task.childThreadId,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  isMissingChild(error)
                    ? Effect.void
                    : Effect.fail(projectionFailure(error, task.childThreadId)),
                onSuccess: Effect.succeed,
              }),
            );
          continuation = listCursor(task.id, null);
          if (projection === undefined) continue;

          const pending = projection.runtimeRequests
            .filter((request) => request.kind === "user_input" && request.status === "pending")
            .toSorted((left, right) => left.id.localeCompare(right.id));
          for (let requestIndex = 0; requestIndex < pending.length; requestIndex += 1) {
            const request = pending[requestIndex];
            if (request === undefined) break;
            if (
              cursor !== null &&
              taskComparison === 0 &&
              cursor.requestId !== null &&
              request.id.localeCompare(cursor.requestId) <= 0
            ) {
              continue;
            }
            requests.push(yield* resultFor({ task, projection, requestId: request.id }));
            continuation = listCursor(task.id, request.id);
            if (requests.length === limit) {
              const hasMoreRequests = pending
                .slice(requestIndex + 1)
                .some((candidate) => candidate.id.localeCompare(request.id) > 0);
              const hasMoreChildren = childIndex + 1 < children.length;
              return {
                requests,
                nextCursor: hasMoreRequests || hasMoreChildren ? continuation : null,
              } satisfies PendingRequestMcpListResult;
            }
          }
        }
        return {
          requests,
          nextCursor:
            projectionCount >= MAX_LIST_CHILD_PROJECTIONS &&
            continuation !== null &&
            lastScannedChildIndex + 1 < children.length
              ? continuation
              : null,
        } satisfies PendingRequestMcpListResult;
      }),
    read: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadParent(scope);
        const child = yield* loadChild(parent, input.childThreadId);
        return yield* resultFor({ ...child, requestId: input.requestId });
      }),
    respond: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* loadParent(scope);
        let child = yield* loadChild(parent, input.childThreadId);
        const id = yield* commandId({
          scope,
          childThreadId: input.childThreadId,
          requestId: input.requestId,
          clientRequestId: input.clientRequestId,
        });
        const receipt = yield* threadManagement
          .getCommandReceipt(id)
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to inspect response receipt '${id}': ${errorMessage(error)}`,
              ),
            ),
          );
        if (Option.isSome(receipt) && receipt.value.status === "accepted") {
          if (
            receipt.value.threadId !== input.childThreadId ||
            receipt.value.commandType !== "runtime-request.respond"
          ) {
            return yield* failure(
              "operation_rejected",
              `Command '${id}' was already used for another operation.`,
            );
          }
          child = yield* loadChild(parent, input.childThreadId);
          const request = yield* resultFor({ ...child, requestId: input.requestId });
          return {
            commandId: id,
            receiptSequence: receipt.value.resultSequence,
            replayed: true,
            request,
          } satisfies PendingRequestMcpRespondResult;
        }
        if (Option.isSome(receipt)) {
          return yield* failure(
            "operation_rejected",
            receipt.value.error ?? `Command '${id}' was previously rejected.`,
          );
        }

        yield* requireResponseCeiling(parent, child.projection);

        const { request, item } = yield* findRequest({ ...child, requestId: input.requestId });
        if (request.status !== "pending") {
          return yield* failure(
            "request_not_pending",
            `User-input request '${request.id}' is ${request.status}.`,
          );
        }
        if (request.responseCapability.type !== "live") {
          return yield* failure("request_not_resumable", request.responseCapability.reason);
        }
        if (!questionPayloadFits(item.questions)) {
          return yield* failure(
            "request_payload_too_large",
            `User-input request '${request.id}' exceeds the bounded MCP question payload and cannot be answered through this tool.`,
          );
        }
        const expectedIds = new Set(item.questions.map((question) => question.id));
        const suppliedIds = Object.keys(input.answers);
        const missing = [...expectedIds].filter((id) => !Object.hasOwn(input.answers, id));
        const unknown = suppliedIds.filter((answerId) => !expectedIds.has(answerId));
        if (missing.length > 0 || unknown.length > 0) {
          return yield* failure(
            "invalid_answers",
            [
              missing.length === 0 ? "" : `Missing question IDs: ${missing.join(", ")}.`,
              unknown.length === 0 ? "" : `Unknown question IDs: ${unknown.join(", ")}.`,
            ]
              .filter(Boolean)
              .join(" "),
          );
        }

        const dispatch = yield* threadManagement
          .dispatch({
            type: "runtime-request.respond",
            commandId: id,
            threadId: input.childThreadId,
            requestId: input.requestId,
            answers: input.answers,
            policyCeiling: {
              callerThreadId: parent.thread.id,
              runtimeMode: parent.thread.runtimeMode,
              interactionMode: parent.thread.interactionMode,
            },
          })
          .pipe(Effect.mapError(dispatchFailure));
        child = yield* loadChild(parent, input.childThreadId);
        const resolved = yield* resultFor({ ...child, requestId: input.requestId });
        return {
          commandId: id,
          receiptSequence: dispatch.sequence,
          replayed: dispatch.replayed ?? false,
          request: resolved,
        } satisfies PendingRequestMcpRespondResult;
      }),
  });
});

export const layer = Layer.effect(PendingRequestMcpService, make);
