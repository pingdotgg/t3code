/**
 * OpenCode subagent projection: child sessions promoted to T3 threads.
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
import * as Effect from "effect/Effect";
import {
  makeSubagentChildThread,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  openCodeChildPermissionRules,
  openCodePermissionRules,
} from "../permissions.ts";
import {
  providerRef,
  unwrapData,
} from "../projection.ts";
import {
  nativeThreadId,
  recordString,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import {
  taskSessionId,
  toolCompletedAt,
  toolInput,
  toolModel,
  toolOutput,
  toolStartedAt,
  toolStatus,
  toolTitle,
} from "../tools.ts";
import type {
  ActiveOpenCodeTurn,
  OpenCodeThreadState,
} from "../types.ts";
import type { Items } from "./items.ts";
import type { State } from "./base.ts";

export const makeSubagents = (deps: State & Items) => {
  const {
    options,
    input,
    client,
    idAllocator,
    now,
    threads,
    subagentsByNativeItemId,
    subagentsByChildSessionId,
    relatedSessionOwners,
    emitProviderEvent,
    sdkCall,
    inputProviderSessionId,
  } = deps;
  const m = deps.mutable;
  const emitSubagent = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    part: ToolPart,
  ) {
    const now = yield* DateTime.now;
    const nativeItemRef = providerRef(part.id);
    const nodeId = idAllocator.derive.nodeFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.id,
    });
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.id,
    });
    turn.usage.hasSubagents = true;
    const input = toolInput(part);
    const prompt = recordString(input, "prompt") ?? "";
    const title = toolTitle(part) ?? recordString(input, "description") ?? null;
    let context = subagentsByNativeItemId.get(part.id);
    if (context === undefined) {
      context = {
        nativeItemId: part.id,
        nodeId,
        parentState: state,
        parentTurn: turn,
        prompt,
        title,
        startedAt: toolStartedAt(part, now),
        childSessionId: null,
        childThreadId: null,
        childProviderThreadId: null,
        model: null,
        result: null,
      };
      subagentsByNativeItemId.set(part.id, context);
    }
    context.model = toolModel(part) ?? context.model;
    const childSessionId = taskSessionId(part);
    if (childSessionId !== null && context.childSessionId === null) {
      context.childSessionId = childSessionId;
      context.childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: OPENCODE_PROVIDER,
        nativeThreadId: childSessionId,
      });
      context.childProviderThreadId = idAllocator.derive.providerThread({
        driver: OPENCODE_PROVIDER,
        nativeThreadId: childSessionId,
      });
      subagentsByChildSessionId.set(childSessionId, context);
      relatedSessionOwners.set(childSessionId, state);
      const childModelSelection: ModelSelection = {
        instanceId: options.instanceId,
        model: context.model ?? turn.modelSelection.model,
      };
      const childThread = makeSubagentChildThread({
        parentThread: turn.appThread,
        childThreadId: context.childThreadId,
        parentNodeId: nodeId,
        activeProviderThreadId: context.childProviderThreadId,
        providerInstanceId: options.instanceId,
        modelSelection: childModelSelection,
        title: subagentThreadTitle({
          parentTitle: turn.appThread.title,
          title,
          prompt,
          ordinal: deps.itemOrdinal(turn, part.id),
        }),
        now,
        createdBy: "agent",
        creationSource: "provider",
      });
      const childProviderThread: OrchestrationV2ProviderThread = {
        id: context.childProviderThreadId,
        driver: OPENCODE_PROVIDER,
        providerInstanceId: options.instanceId,
        providerSessionId: inputProviderSessionId,
        appThreadId: context.childThreadId,
        ownerNodeId: nodeId,
        nativeThreadRef: providerRef(childSessionId),
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const childSessionResponse = yield* sdkCall(
        "session.get",
        { sessionID: childSessionId },
        () => client.session.get({ sessionID: childSessionId }),
      );
      const nativeChildSession = unwrapData("session.get", childSessionResponse);
      const childPermission = openCodeChildPermissionRules(
        turn.runtimePolicy,
        nativeChildSession.permission ?? [],
      );
      yield* sdkCall(
        "session.update",
        { sessionID: childSessionId, permission: childPermission },
        () =>
          client.session.update({
            sessionID: childSessionId,
            permission: childPermission,
          }),
      );
      threads.set(childSessionId, {
        nativeSessionId: childSessionId,
        providerThread: childProviderThread,
        appThread: childThread,
        activeTurn: null,
        providerTurns: new Map(),
        runtimeRequests: new Map(),
        messageRoles: new Map(),
        userMessageIds: [],
        parentSubagent: context,
        nextChildTurnOrdinal: 1,
        nextAdmissionGeneration: 1,
        permission: childPermission,
        inheritedPermission: openCodePermissionRules(turn.runtimePolicy),
      });
      yield* emitProviderEvent({
        type: "app_thread.created",
        driver: OPENCODE_PROVIDER,
        appThread: childThread,
      });
      yield* emitProviderEvent({
        type: "provider_thread.updated",
        driver: OPENCODE_PROVIDER,
        providerThread: childProviderThread,
      });
    }
    const output = toolOutput(part);
    if (part.state.status === "completed" && output !== undefined) context.result = output;
    const status = toolStatus(part);
    const completedAt = toolCompletedAt(part, now);
    const subagentStatus: OrchestrationV2Subagent["status"] =
      status.item === "failed"
        ? "failed"
        : status.item === "completed"
          ? "completed"
          : status.item === "pending"
            ? "pending"
            : "running";
    const subagent: OrchestrationV2Subagent = {
      id: nodeId,
      threadId: turn.threadId,
      runId: turn.runId,
      parentNodeId: turn.rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: OPENCODE_PROVIDER,
      providerInstanceId: options.instanceId,
      providerThreadId: context.childProviderThreadId,
      childThreadId: context.childThreadId,
      nativeTaskRef: nativeItemRef,
      prompt,
      title,
      model: context.model,
      status: subagentStatus,
      result: context.result,
      startedAt: context.startedAt,
      completedAt,
      updatedAt: now,
    };
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: nodeId,
        threadId: turn.threadId,
        runId: turn.runId,
        parentNodeId: turn.rootNodeId,
        rootNodeId: turn.rootNodeId,
        kind: "subagent",
        status: status.node,
        countsForRun: false,
        providerThreadId: context.childProviderThreadId ?? state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: context.startedAt,
        completedAt,
      },
    });
    yield* emitProviderEvent({
      type: "subagent.updated",
      driver: OPENCODE_PROVIDER,
      subagent,
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: {
        id: turnItemId,
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal: deps.itemOrdinal(turn, part.id),
        status: status.item,
        title,
        startedAt: context.startedAt,
        completedAt,
        updatedAt: now,
        type: "subagent",
        subagentId: nodeId,
        origin: "provider_native",
        driver: OPENCODE_PROVIDER,
        providerInstanceId: options.instanceId,
        childThreadId: context.childThreadId,
        prompt,
        result: context.result,
      },
    });
  });

  return { emitSubagent };
};

export type Subagents = ReturnType<typeof makeSubagents>;
