/**
 * OpenCode runtime request projection and permission/question routing.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import {
  topLevelRequestOwner,
} from "../admission.ts";
import {
  openCodePermissionRequestKind,
} from "../permissions.ts";
import {
  providerRef,
} from "../projection.ts";
import {
  protocolError,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import type {
  OpenCodeRequestOwner,
  PendingOpenCodeRequest,
} from "../types.ts";
import type { Items } from "./items.ts";
import type { State } from "./base.ts";

export const makeRequests = (deps: State & Items) => {
  const {
    options,
    client,
    scope,
    idAllocator,
    now,
    threads,
    pendingRequests,
    pendingRequestsByNativeId,
    relatedSessionOwners,
    settledNativeRequestIds,
    pendingChildRequestRoutes,
    emitProviderEvent,
    sdkCall,
    inputProviderSessionId,
  } = deps;
  const m = deps.mutable;
  const requestQuestions = (request: QuestionRequest) =>
    request.questions.map((question, index) => ({
      id: OpenCodeRuntime.openCodeQuestionId(index, question),
      header: question.header.trim() || `Question ${index + 1}`,
      question: question.question.trim() || question.header.trim() || `Question ${index + 1}`,
      ...(question.multiple === undefined ? {} : { multiSelect: question.multiple }),
      ...(question.custom === undefined ? {} : { allowCustomAnswer: question.custom }),
      options: question.options.map((option) => ({
        label: option.label.trim() || "Option",
        description: option.description.trim() || option.label.trim() || "Option",
      })),
    }));

  const runtimeRequestTurnItem = (
    pending: PendingOpenCodeRequest,
    status: OrchestrationV2TurnItem["status"],
    completedAt: DateTime.Utc | null,
    updatedAt: DateTime.Utc,
  ): OrchestrationV2TurnItem => {
    const base = {
      id: pending.turnItemId,
      threadId: pending.turn.threadId,
      runId: pending.turn.runId,
      nodeId: pending.nodeId,
      providerThreadId: pending.state.providerThread.id,
      providerTurnId: pending.turn.providerTurnId,
      nativeItemRef: providerRef(pending.nativeRequestId),
      parentItemId: null,
      ordinal: deps.itemOrdinal(pending.turn, pending.nativeRequestId),
      status,
      startedAt: pending.createdAt,
      completedAt,
      updatedAt,
    };
    if (pending.question !== undefined) {
      return {
        ...base,
        title: "User input",
        type: "user_input_request",
        requestId: pending.requestId,
        questions: requestQuestions(pending.question),
      };
    }
    const permission = pending.permission;
    if (permission === undefined) {
      throw protocolError(`OpenCode request ${pending.requestId} has no native payload`);
    }
    return {
      ...base,
      title: permission.permission,
      type: "approval_request",
      requestId: pending.requestId,
      requestKind: pending.requestKind === "user_input" ? "command" : pending.requestKind,
      prompt:
        permission.patterns.length === 0
          ? permission.permission
          : permission.patterns.join("\n"),
    };
  };

  const emitRuntimeRequest = Effect.fnUntraced(function* (
    owner: OpenCodeRequestOwner,
    nativeRequestId: string,
    request:
      | { readonly type: "permission"; readonly value: PermissionRequest }
      | { readonly type: "question"; readonly value: QuestionRequest },
  ) {
    if (pendingRequestsByNativeId.has(nativeRequestId)) return;
    const { state, turn, subagent } = owner;
    const now = yield* DateTime.now;
    const requestId = yield* idAllocator.allocate.runtimeRequest({
      driver: OPENCODE_PROVIDER,
      providerTurnId: turn.providerTurnId,
      nativeRequestId,
    });
    const nodeId = idAllocator.derive.approvalNode({ requestId });
    const turnItemId = idAllocator.derive.approvalTurnItem({ requestId });
    const permissionToolName =
      request.type === "permission" && request.value.tool !== undefined
        ? threads
            .get(request.value.sessionID)
            ?.activeTurn?.toolNamesByCallId.get(request.value.tool.callID)
        : undefined;
    const permissionRequestKind =
      request.type === "permission"
        ? openCodePermissionRequestKind(request.value.permission, permissionToolName)
        : undefined;
    const requestKind: OrchestrationV2RuntimeRequest["kind"] =
      permissionRequestKind ?? "user_input";
    const pending: PendingOpenCodeRequest = {
      requestId,
      nativeRequestId,
      nativeSessionId: request.value.sessionID,
      turn,
      state,
      nodeId,
      parentNodeId: subagent?.nodeId ?? turn.rootNodeId,
      turnItemId,
      requestKind,
      createdAt: now,
      ...(request.type === "permission"
        ? { permission: request.value }
        : { question: request.value }),
    };
    pendingRequests.set(String(requestId), pending);
    pendingRequestsByNativeId.set(nativeRequestId, pending);
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: turn.providerTurnId,
      nativeRequestRef: providerRef(nativeRequestId),
      kind: requestKind,
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId: inputProviderSessionId,
      },
      createdAt: now,
      resolvedAt: null,
    };
    state.runtimeRequests.set(String(requestId), runtimeRequest);
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: pending.parentNodeId,
        rootNodeId: turn.rootNodeId,
        kind: request.type === "question" ? "user_input_request" : "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: providerRef(nativeRequestId),
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* emitProviderEvent({
      type: "runtime_request.updated",
      driver: OPENCODE_PROVIDER,
      threadId: turn.threadId,
      runtimeRequest,
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: runtimeRequestTurnItem(pending, "waiting", null, now),
    });
    yield* deps.updateProviderSession("waiting", null);
  });

  const resolveRuntimeRequest = Effect.fnUntraced(function* (
    nativeRequestId: string,
    status: "resolved" | "cancelled",
  ) {
    const pending = pendingRequestsByNativeId.get(nativeRequestId);
    if (pending === undefined) return;
    const now = yield* DateTime.now;
    const current = pending.state.runtimeRequests.get(String(pending.requestId));
    if (current !== undefined) {
      const resolved: OrchestrationV2RuntimeRequest = {
        ...current,
        status,
        resolvedAt: now,
      };
      pending.state.runtimeRequests.set(String(pending.requestId), resolved);
      yield* emitProviderEvent({
        type: "runtime_request.updated",
        driver: OPENCODE_PROVIDER,
        threadId: pending.turn.threadId,
        runtimeRequest: resolved,
      });
    }
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: pending.nodeId,
        threadId: pending.turn.threadId,
        runId: pending.turn.runId,
        parentNodeId: pending.parentNodeId,
        rootNodeId: pending.turn.rootNodeId,
        kind: pending.question === undefined ? "approval_request" : "user_input_request",
        status: status === "resolved" ? "completed" : "cancelled",
        countsForRun: false,
        providerThreadId: pending.state.providerThread.id,
        providerTurnId: pending.turn.providerTurnId,
        nativeItemRef: providerRef(nativeRequestId),
        runtimeRequestId: pending.requestId,
        checkpointScopeId: null,
        startedAt: pending.createdAt,
        completedAt: now,
      },
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: runtimeRequestTurnItem(
        pending,
        status === "resolved" ? "completed" : "cancelled",
        now,
        now,
      ),
    });
    pendingRequests.delete(String(pending.requestId));
    pendingRequestsByNativeId.delete(nativeRequestId);
    const hasOtherPending = Array.from(pendingRequests.values()).some(
      (candidate) => candidate.turn.isRoot,
    );
    if (!hasOtherPending) yield* deps.updateProviderSession("running", null);
  });

  const resolveSessionOwner = Effect.fnUntraced(function* (sessionId: string) {
    const known = threads.get(sessionId) ?? relatedSessionOwners.get(sessionId);
    if (known !== undefined) return known;
    let cursor = sessionId;
    const hops: string[] = [];
    for (let depth = 0; depth < 5; depth += 1) {
      const response = yield* sdkCall("session.get", { sessionID: cursor }, () =>
        client.session.get({ sessionID: cursor }),
      ).pipe(Effect.option);
      const info = Option.getOrUndefined(response)?.data;
      const parentId = info?.parentID;
      if (parentId === undefined) return undefined;
      hops.push(cursor);
      const owner = threads.get(parentId) ?? relatedSessionOwners.get(parentId);
      if (owner !== undefined) {
        for (const hop of hops) relatedSessionOwners.set(hop, owner);
        return owner;
      }
      cursor = parentId;
    }
    return undefined;
  });

  const routeRuntimeRequest = Effect.fnUntraced(function* (
    nativeRequestId: string,
    sessionId: string,
    request:
      | { readonly type: "permission"; readonly value: PermissionRequest }
      | { readonly type: "question"; readonly value: QuestionRequest },
  ) {
    if (pendingChildRequestRoutes.has(nativeRequestId)) return;
    const attempt = Effect.gen(function* () {
      if (
        settledNativeRequestIds.has(nativeRequestId) ||
        pendingRequestsByNativeId.has(nativeRequestId)
      ) {
        return true;
      }
      const state = yield* resolveSessionOwner(sessionId);
      const owner = state === undefined ? undefined : topLevelRequestOwner(state);
      if (owner === undefined) return false;
      yield* emitRuntimeRequest(owner, nativeRequestId, request);
      return true;
    });
    if (yield* attempt) return;
    pendingChildRequestRoutes.add(nativeRequestId);
    yield* Effect.gen(function* () {
      for (let retry = 0; retry < 5; retry += 1) {
        yield* Effect.sleep(Duration.millis(Math.min(200 * 2 ** retry, 2_000)));
        if (yield* attempt) return;
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => pendingChildRequestRoutes.delete(nativeRequestId))),
      Effect.forkIn(scope),
    );
  });

  return { requestQuestions, runtimeRequestTurnItem, emitRuntimeRequest, resolveRuntimeRequest, resolveSessionOwner, routeRuntimeRequest };
};

export type Requests = ReturnType<typeof makeRequests>;
