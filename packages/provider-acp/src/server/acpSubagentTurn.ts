// ACP session behaviour extracted from server/adapter.ts (subagentTurn).

import {
  acpSubagentStatusIsTerminal,
  type ActiveAcpTurn,
  type ActiveAcpSubagent,
} from "./acpTurnModel.ts";
import {
  makeSubagentChildThread,
  subagentThreadTitle,
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import { makeProviderThread } from "./acpThreadContext.ts";
import { type AcpAdapterV2SubagentUpdate } from "./acpAdapterConfig.ts";
import { type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx5 } from "./acpSessionContext.ts";

export const createAcpSubagentTurn = (ctx: AcpSessionCtx5) => {
  const emitSubagent = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    reported: AcpAdapterV2SubagentUpdate,
  ) {
    // See stoppedToolStatus: after Stop, a failed subagent was interrupted.
    const update: AcpAdapterV2SubagentUpdate =
      context.interrupted && reported.status === "failed"
        ? { ...reported, status: "interrupted" }
        : reported;
    // Hydration uses a new toolCallId but references the original child by subagent_id or task id.
    const existing =
      context.subagents.get(update.nativeTaskId) ??
      (update.childSessionId !== null
        ? context.subagentsBySessionId.get(update.childSessionId)
        : undefined);
    const updateIsTerminal = acpSubagentStatusIsTerminal(update.status);
    if (
      existing !== undefined &&
      acpSubagentStatusIsTerminal(existing.task.status) &&
      !updateIsTerminal
    ) {
      return;
    }
    if (
      existing !== undefined &&
      existing.task.status === update.status &&
      updateIsTerminal &&
      existing.terminalStatusProjected
    ) {
      return;
    }
    // Empty-prompt hydration must match existing lineage; only spawn ACKs can create it.
    if (existing === undefined) {
      const isHydrationOnly = update.prompt === "" && update.title === null;
      if (isHydrationOnly || update.suppressNormalTool === false) {
        return;
      }
    }
    const now = yield* DateTime.now;
    const nativeTaskId = existing?.task.nativeTaskRef?.nativeId ?? update.nativeTaskId;
    const nativeItemRef = {
      driver: ctx.driver,
      nativeId: nativeTaskId,
      strength: "strong" as const,
    };
    const nodeId = existing?.task.id ?? ctx.providerNodeId(nativeTaskId);
    const childThreadId =
      existing?.childThreadId ??
      ctx.idAllocator.derive.threadFromProviderThread({
        driver: ctx.driver,
        providerInstanceId: context.input.modelSelection.instanceId,
        nativeThreadId: `${context.nativeThreadId}:task:${nativeTaskId}`,
      });
    const childRootNodeId =
      existing?.childRootNodeId ?? ctx.providerNodeId(`${nativeTaskId}:child-root`);
    const turnItemId = existing?.turnItemId ?? ctx.providerTurnItemId(nativeTaskId);
    const turnItemOrdinal =
      existing?.turnItemOrdinal ?? (yield* ctx.resolveItemOrdinal(context, nativeTaskId));
    const taskStatus = update.status;
    const task: OrchestrationV2Subagent = {
      ...(existing?.task ?? {
        id: nodeId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        parentNodeId: context.input.rootNodeId,
        origin: "provider_native" as const,
        createdBy: "agent" as const,
        driver: ctx.driver,
        providerInstanceId: context.input.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: nativeItemRef,
        prompt: update.prompt,
        title: update.title,
        result: null,
        startedAt: now,
      }),
      model: update.model?.trim() || existing?.task.model || null,
      status: taskStatus,
      result: update.result ?? existing?.task.result ?? null,
      completedAt: acpSubagentStatusIsTerminal(taskStatus) ? now : null,
      updatedAt: now,
    };
    const subagent: ActiveAcpSubagent = existing ?? {
      task,
      childThreadId,
      childRootNodeId,
      turnItemId,
      turnItemOrdinal,
      providerTurnId: context.providerTurnId,
      parentProviderThreadId: context.input.providerThread.id,
      childSessionId: null,
      assistantText: "",
      assistantMessages: new Map(),
      childItemOrdinals: new Map(),
      nextChildOrdinal: 101,
      terminalStatusProjected: false,
      toolState: {
        tools: new Map(),
        toolUpdatesSkipped: new Map(),
        toolStartedAt: new Map(),
      },
      toolSessionIds: new Map(),
    };
    subagent.task = task;
    context.subagents.set(nativeTaskId, subagent);

    if (existing === undefined) {
      yield* ctx.emitProviderEvent({
        type: "app_thread.created",
        driver: ctx.driver,
        appThread: makeSubagentChildThread({
          parentThread: context.input.appThread,
          childThreadId,
          parentNodeId: nodeId,
          activeProviderThreadId: null,
          providerInstanceId: context.input.modelSelection.instanceId,
          modelSelection: {
            ...context.input.modelSelection,
            model: task.model ?? context.input.modelSelection.model,
          },
          title: subagentThreadTitle({
            parentTitle: context.input.appThread.title,
            title: update.title,
            prompt: update.prompt,
            ordinal: context.subagents.size,
          }),
          now,
          createdBy: "agent",
          creationSource: "provider",
        }),
      });
      const promptNativeItemId = `${nativeTaskId}:prompt`;
      const promptArtifacts = makeSubagentConversationArtifacts({
        senderThreadId: context.input.threadId,
        messageId: ctx.providerMessageId(promptNativeItemId),
        turnItemId: ctx.providerTurnItemId(promptNativeItemId),
        threadId: childThreadId,
        rootNodeId: childRootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: { driver: ctx.driver, nativeId: promptNativeItemId, strength: "weak" },
        role: "user",
        text: update.prompt,
        ordinal: 100,
        now,
      });
      yield* ctx.emitProviderEvent({
        type: "message.updated",
        driver: ctx.driver,
        message: promptArtifacts.message,
      });
      yield* ctx.emitProviderEvent({
        type: "turn_item.updated",
        driver: ctx.driver,
        turnItem: promptArtifacts.turnItem,
      });
    }

    const childSessionId = update.childSessionId;
    if (childSessionId !== null && subagent.childSessionId === null) {
      subagent.childSessionId = childSessionId;
      context.subagentsBySessionId.set(childSessionId, subagent);
      const providerThread = makeProviderThread({
        driver: ctx.driver,
        providerInstanceId: context.input.modelSelection.instanceId,
        idAllocator: ctx.idAllocator,
        appThreadId: childThreadId,
        providerSessionId: ctx.input.providerSessionId,
        nativeThreadId: childSessionId,
        ...(ctx.itemIdentityVersion === undefined ? {} : { itemIdentityVersion: ctx.itemIdentityVersion }),
        forkedFrom: {
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
        },
        now,
      });
      subagent.task = { ...subagent.task, providerThreadId: providerThread.id };
      yield* Ref.update(ctx.providerThreadByNativeSessionId, (current) =>
        new Map(current).set(childSessionId, providerThread),
      );
      yield* ctx.emitProviderEvent({
        type: "provider_thread.updated",
        driver: ctx.driver,
        providerThread: { ...providerThread, status: "idle" },
      });
      const buffered = context.pendingSubagentNotifications.get(childSessionId) ?? [];
      context.pendingSubagentNotifications.delete(childSessionId);
      yield* Effect.forEach(
        buffered,
        (notification) => ctx.projectSubagentNotification(subagent, notification),
        { concurrency: 1, discard: true },
      );
    }

    if (
      taskStatus !== "running" &&
      subagent.assistantText.length === 0 &&
      update.result !== null
    ) {
      yield* ctx.emitSubagentAssistant(subagent, update.result);
    }
    const result = update.result ?? subagent.task.result ?? (subagent.assistantText || null);
    subagent.task = {
      ...subagent.task,
      status: taskStatus,
      result,
      completedAt: acpSubagentStatusIsTerminal(taskStatus) ? now : null,
      updatedAt: now,
    };
    const providerThreadId = subagent.task.providerThreadId;
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: nodeId,
        threadId: context.input.threadId,
        runId: subagent.task.runId,
        parentNodeId: subagent.task.parentNodeId,
        rootNodeId: subagent.task.parentNodeId,
        kind: "subagent",
        status: taskStatus,
        countsForRun: false,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: subagent.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: subagent.task.startedAt,
        completedAt: subagent.task.completedAt,
      },
    });
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: childRootNodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childRootNodeId,
        kind: "root_turn",
        status: taskStatus,
        countsForRun: false,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: subagent.task.startedAt,
        completedAt: subagent.task.completedAt,
      },
    });
    yield* ctx.emitProviderEvent({ type: "subagent.updated", driver: ctx.driver, subagent: subagent.task });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: {
        id: turnItemId,
        threadId: context.input.threadId,
        runId: subagent.task.runId,
        nodeId,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: subagent.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal: turnItemOrdinal,
        status: taskStatus,
        title: subagent.task.title,
        startedAt: subagent.task.startedAt,
        completedAt: subagent.task.completedAt,
        updatedAt: now,
        type: "subagent",
        subagentId: subagent.task.id,
        origin: "provider_native",
        driver: ctx.driver,
        providerInstanceId: context.input.modelSelection.instanceId,
        childThreadId,
        prompt: subagent.task.prompt,
        result,
      },
    });
    if (acpSubagentStatusIsTerminal(taskStatus)) {
      subagent.terminalStatusProjected = true;
    }
  });
  return {
    emitSubagent,
  };
};
