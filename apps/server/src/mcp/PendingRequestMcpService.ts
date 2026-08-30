import {
  CommandId,
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
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { interactionModeWithinMcpCeiling, runtimeModeWithinMcpCeiling } from "./McpModeCeilings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_LIST_LIMIT = 20;

function parseListCursor(
  cursor: string | undefined,
): Effect.Effect<
  { readonly childIndex: number; readonly requestIndex: number },
  PendingRequestMcpFailure
> {
  if (cursor === undefined) return Effect.succeed({ childIndex: 0, requestIndex: 0 });
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(cursor);
  if (match === null) {
    return Effect.fail(failure("invalid_request", "The pending-request cursor is invalid."));
  }
  const childIndex = Number(match[1]);
  const requestIndex = Number(match[2]);
  return Number.isSafeInteger(childIndex) && Number.isSafeInteger(requestIndex)
    ? Effect.succeed({ childIndex, requestIndex })
    : Effect.fail(failure("invalid_request", "The pending-request cursor is invalid."));
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

const isThreadNotFound = Schema.is(ThreadManagementThreadNotFoundError);

function projectionFailure(error: unknown, threadId: ThreadId): PendingRequestMcpFailure {
  return isThreadNotFound(error)
    ? failure("child_not_found", `Delegated child thread '${threadId}' was not found.`)
    : failure(
        "orchestration_error",
        `Unable to load delegated child thread '${threadId}': ${errorMessage(error)}`,
      );
}

function dispatchFailure(error: unknown): PendingRequestMcpFailure {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { readonly _tag: unknown })._tag)
      : "";
  return tag === "OrchestratorDispatchError" ||
    tag === "OrchestratorCommandPreviouslyRejectedError" ||
    tag === "OrchestratorCommandIdConflictError"
    ? failure("operation_rejected", errorMessage(error))
    : failure("orchestration_error", errorMessage(error));
}

function directAppOwnedChildren(parent: OrchestrationV2ThreadProjection) {
  return parent.subagents
    .filter(
      (task): task is OrchestrationV2Subagent & { readonly childThreadId: ThreadId } =>
        task.origin === "app_owned" && task.childThreadId !== null,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        right.id.localeCompare(left.id),
    );
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
    questions: input.item.questions,
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
        let childIndex = cursor.childIndex;
        let requestIndex = cursor.requestIndex;
        while (childIndex < children.length && requests.length < limit) {
          const task = children[childIndex];
          if (task === undefined) break;
          const projection = yield* threadManagement
            .getProjectThread({
              projectId: parent.thread.projectId,
              threadId: task.childThreadId,
            })
            .pipe(Effect.mapError((error) => projectionFailure(error, task.childThreadId)));
          const pending = projection.runtimeRequests.filter(
            (request) => request.kind === "user_input" && request.status === "pending",
          );
          while (requestIndex < pending.length && requests.length < limit) {
            const request = pending[requestIndex];
            if (request === undefined) break;
            requests.push(yield* resultFor({ task, projection, requestId: request.id }));
            requestIndex += 1;
          }
          if (requestIndex < pending.length) break;
          childIndex += 1;
          requestIndex = 0;
        }
        return {
          requests,
          nextCursor: childIndex < children.length ? `${childIndex}:${requestIndex}` : null,
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
        const expectedIds = new Set(item.questions.map((question) => question.id));
        const suppliedIds = Object.keys(input.answers);
        const missing = [...expectedIds].filter((id) => !(id in input.answers));
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
