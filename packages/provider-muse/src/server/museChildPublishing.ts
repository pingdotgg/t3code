import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type {
  NodeId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  ProviderInstanceId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";

import { MUSE_PROVIDER } from "./museCapabilities.ts";
import type { MuseItemProjection } from "./museItemProjection.ts";
import type { ActiveTurn, ChildContext, PendingRequest } from "./museSessionTypes.ts";
import type { MuseItem } from "./protocol.ts";

export interface MuseChildPublishingDeps {
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly pending: Map<RuntimeRequestId, PendingRequest>;
  readonly childrenByItemId: Map<string, ChildContext>;
  readonly agentTitles: Map<string, string>;
  readonly agentEndedAt: Map<string, DateTime.Utc>;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly instanceId: ProviderInstanceId;
  readonly baseItem: MuseItemProjection["baseItem"];
  readonly childItemIdentity: MuseItemProjection["childItemIdentity"];
  readonly nativeRef: MuseItemProjection["nativeRef"];
  readonly backgroundTaskId: MuseItemProjection["backgroundTaskId"];
}

/** Subagent and workflow children get their own threads, so they publish through their own layer. */
export const makeMuseChildPublishing = (deps: MuseChildPublishingDeps) => {
  const {
    emit,
    pending,
    childrenByItemId,
    agentTitles,
    agentEndedAt,
    idAllocator,
    instanceId,
    baseItem,
    childItemIdentity,
    nativeRef,
    backgroundTaskId,
  } = deps;
  const publishChildRoot = Effect.fnUntraced(function* (
    context: ChildContext,
    status: OrchestrationV2TurnItemStatus,
    time: DateTime.Utc,
  ) {
    context.status = status;
    yield* emit({
      type: "node.updated",
      driver: MUSE_PROVIDER,
      node: {
        id: context.rootNodeId,
        threadId: context.childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: context.rootNodeId,
        kind: "root_turn",
        status,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeRef(context.childSessionId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: context.appThread.createdAt,
        completedAt: status === "running" || status === "pending" ? null : time,
      },
    });
  });
  const publishChildMessage = Effect.fnUntraced(function* (
    context: ChildContext,
    role: "user" | "assistant",
    text: string,
    suffix: "prompt" | "result",
    time: DateTime.Utc,
  ) {
    const identity = childItemIdentity(context, suffix);
    const artifacts = makeSubagentConversationArtifacts({
      messageId: idAllocator.derive.messageFromProviderItem({
        driver: MUSE_PROVIDER,
        nativeItemId: identity,
      }),
      ...(role === "user" ? { senderThreadId: context.parentThreadId } : {}),
      turnItemId: idAllocator.derive.turnItemFromProviderItem({
        driver: MUSE_PROVIDER,
        nativeItemId: identity,
      }),
      threadId: context.childThreadId,
      rootNodeId: context.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: nativeRef(context.childSessionId),
      role,
      text,
      ordinal: suffix === "prompt" ? 1 : 2,
      now: time,
    });
    yield* emit({ type: "message.updated", driver: MUSE_PROVIDER, message: artifacts.message });
    yield* emit({
      type: "turn_item.updated",
      driver: MUSE_PROVIDER,
      turnItem: artifacts.turnItem,
    });
  });
  const ensureChildContext = Effect.fnUntraced(function* (
    turn: ActiveTurn,
    item: MuseItem,
    parentNodeId: NodeId,
    title: string,
    prompt: string,
    status: OrchestrationV2TurnItemStatus,
    time: DateTime.Utc,
  ) {
    const existing = childrenByItemId.get(item.itemId);
    const childSessionId = item.childSessionId;
    if (existing || !childSessionId) return existing;
    const childThreadId = idAllocator.derive.threadFromProviderThread({
      driver: MUSE_PROVIDER,
      providerInstanceId: instanceId,
      nativeThreadId: childSessionId,
    });
    const appThread = makeSubagentChildThread({
      parentThread: turn.input.appThread,
      childThreadId,
      parentNodeId,
      activeProviderThreadId: null,
      providerInstanceId: instanceId,
      modelSelection: turn.input.modelSelection,
      title,
      now: time,
      createdBy: "agent",
      creationSource: "provider",
    });
    const context: ChildContext = {
      childSessionId,
      childThreadId,
      appThread,
      rootNodeId: idAllocator.derive.nodeFromProviderItem({
        driver: MUSE_PROVIDER,
        nativeItemId: `${instanceId}:child:${childSessionId}:thread-root`,
      }),
      parentThreadId: turn.input.threadId,
      status,
    };
    childrenByItemId.set(item.itemId, context);
    yield* emit({ type: "app_thread.created", driver: MUSE_PROVIDER, appThread });
    yield* publishChildRoot(context, status, time);
    if (prompt) yield* publishChildMessage(context, "user", prompt, "prompt", time);
    return context;
  });
  const publishNativeSubagent = Effect.fnUntraced(function* (
    turn: ActiveTurn,
    item: MuseItem,
    base: ReturnType<MuseItemProjection["baseItem"]> & {
      readonly status: OrchestrationV2TurnItemStatus;
      readonly completedAt: DateTime.Utc | null;
      readonly title: string | null;
    },
    status: OrchestrationV2TurnItemStatus,
    time: DateTime.Utc,
  ) {
    const prompt = item.objective ?? item.fallbackText ?? "";
    const settled = status !== "running" && status !== "pending";
    const endKey = `subagent:${item.itemId}`;
    if (settled && !agentEndedAt.has(endKey)) agentEndedAt.set(endKey, time);
    if (!settled) agentEndedAt.delete(endKey);
    const completedAt = settled ? (agentEndedAt.get(endKey) ?? time) : null;
    if (!agentTitles.has(endKey))
      agentTitles.set(
        endKey,
        subagentThreadTitle({
          parentTitle: turn.input.appThread.title,
          prompt,
          title: item.role ?? null,
          ordinal: childrenByItemId.size + 1,
        }),
      );
    const title = agentTitles.get(endKey)!;
    const context = yield* ensureChildContext(
      turn,
      item,
      base.nodeId,
      title,
      prompt,
      status,
      time,
    );
    const resultText =
      item.result?.text ??
      item.result?.summary ??
      (status === "failed" ? item.failureReason : undefined);
    const result = resultText ?? null;
    const nativeTaskRef = nativeRef(backgroundTaskId(item));
    const subagent: OrchestrationV2Subagent = {
      id: base.nodeId,
      threadId: base.threadId,
      runId: base.runId,
      parentNodeId: turn.input.rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: MUSE_PROVIDER,
      providerInstanceId: instanceId,
      providerThreadId: base.providerThreadId,
      childThreadId: context?.childThreadId ?? null,
      nativeTaskRef,
      prompt,
      title,
      model: null,
      status,
      result,
      startedAt: base.startedAt,
      completedAt,
      updatedAt: time,
    };
    yield* emit({ type: "subagent.updated", driver: MUSE_PROVIDER, subagent });
    yield* emit({
      type: "node.updated",
      driver: MUSE_PROVIDER,
      node: {
        id: base.nodeId,
        threadId: base.threadId,
        runId: base.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind: "subagent",
        status,
        countsForRun: false,
        providerThreadId: base.providerThreadId,
        providerTurnId: base.providerTurnId,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: base.startedAt,
        completedAt,
      },
    });
    yield* emit({
      type: "turn_item.updated",
      driver: MUSE_PROVIDER,
      turnItem: {
        ...base,
        nativeItemRef: nativeTaskRef,
        type: "subagent",
        status,
        title,
        completedAt,
        subagentId: subagent.id,
        origin: "provider_native",
        driver: MUSE_PROVIDER,
        providerInstanceId: instanceId,
        childThreadId: subagent.childThreadId,
        prompt,
        result,
      },
    });
    if (context) {
      if (context.status !== status) yield* publishChildRoot(context, status, time);
      if (settled && result?.trim() && context.result !== result) {
        context.result = result;
        yield* publishChildMessage(context, "assistant", result, "result", time);
      }
    }
  });
  const publishWorkflowAgents = Effect.fnUntraced(function* (
    turn: ActiveTurn,
    item: MuseItem,
    workflow: { readonly id: OrchestrationV2TurnItem["id"]; readonly nodeId: NodeId },
    workflowStatus: OrchestrationV2TurnItemStatus,
  ) {
    const latest = new Map((item.children ?? []).map((child) => [child.childId, child]));
    for (const [index, child] of [...latest.values()].entries()) {
      const time = yield* DateTime.now;
      const base = baseItem(turn, `${item.itemId}:agent:${child.childId}`, time);
      // Muse marks a failed attempt with `failureKind`, even when its terminal is `completed`.
      const status: OrchestrationV2TurnItemStatus =
        child.terminal === "completed" && child.failureKind === undefined
          ? "completed"
          : child.terminal === "cancelled"
            ? "cancelled"
            : child.terminal !== undefined
              ? "failed"
              : workflowStatus !== "running"
                ? workflowStatus
                : child.status === "scheduled"
                  ? "pending"
                  : "running";
      const settled = status !== "running" && status !== "pending";
      // Children are re-sent on every workflow change; keep each one's first end time.
      const endKey = `${item.itemId}:${child.childId}:${child.attempt}`;
      if (settled && !agentEndedAt.has(endKey)) agentEndedAt.set(endKey, time);
      // Later revisions drop the label; keep the last one seen.
      if (child.label?.trim()) agentTitles.set(endKey, child.label.trim());
      const title = agentTitles.get(endKey) || `Agent ${index + 1}`;
      const result = child.failureReason ?? child.failureKind ?? null;
      const subagent: OrchestrationV2Subagent = {
        id: base.nodeId,
        threadId: base.threadId,
        runId: base.runId,
        parentNodeId: workflow.nodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver: MUSE_PROVIDER,
        providerInstanceId: instanceId,
        providerThreadId: base.providerThreadId,
        childThreadId: null,
        nativeTaskRef: nativeRef(child.childId),
        prompt: title,
        title,
        model: null,
        status,
        result,
        startedAt: base.startedAt,
        completedAt: settled ? (agentEndedAt.get(endKey) ?? time) : null,
        updatedAt: time,
      };
      yield* emit({ type: "subagent.updated", driver: MUSE_PROVIDER, subagent });
      yield* emit({
        type: "node.updated",
        driver: MUSE_PROVIDER,
        node: {
          id: base.nodeId,
          threadId: base.threadId,
          runId: base.runId,
          parentNodeId: workflow.nodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "subagent",
          status,
          countsForRun: false,
          providerThreadId: base.providerThreadId,
          providerTurnId: base.providerTurnId,
          nativeItemRef: subagent.nativeTaskRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: base.startedAt,
          completedAt: subagent.completedAt,
        },
      });
      yield* emit({
        type: "turn_item.updated",
        driver: MUSE_PROVIDER,
        turnItem: {
          ...base,
          nativeItemRef: subagent.nativeTaskRef,
          parentItemId: workflow.id,
          type: "subagent",
          status,
          title,
          completedAt: subagent.completedAt,
          subagentId: subagent.id,
          origin: "provider_native",
          driver: MUSE_PROVIDER,
          providerInstanceId: instanceId,
          childThreadId: null,
          prompt: title,
          result,
        },
      });
    }
  });

  return {
    publishChildRoot,
    publishChildMessage,
    ensureChildContext,
    publishNativeSubagent,
    publishWorkflowAgents,
  };
};

export type MuseChildPublishing = ReturnType<typeof makeMuseChildPublishing>;
