// ACP session behaviour extracted from server/adapter.ts (nativeChildren).

import {
  acpSubagentStatusIsTerminal,
  type AcpNativeChildSession,
  type ActiveAcpTurn,
} from "./acpTurnModel.ts";
import {
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import { parseSessionUpdateEvent } from "./runtimeModel.ts";
import { toolStatus, stoppedToolStatus } from "./acpToolCallProjection.ts";
import { type AcpAdapterV2SubagentUpdate } from "./acpAdapterConfig.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx6 } from "./acpSessionContext.ts";

export const createAcpNativeChildren = (ctx: AcpSessionCtx6) => {
  const nativeChild = (sessionId: string) => {
    let child = ctx.nativeChildren.get(sessionId);
    if (child === undefined) {
      child = {
        parentSessionId: null,
        status: "running",
        result: null,
        delegationId: null,
        prompt: "",
        subagent: undefined,
        owner: undefined,
        pending: [],
      };
      ctx.nativeChildren.set(sessionId, child);
    }
    return child;
  };
  const setNativeChildState = (
    child: AcpNativeChildSession,
    status: AcpNativeChildSession["status"],
    result: string | null,
  ) => {
    if (child.status !== "running" && status === "running" && child.subagent !== undefined) {
      // A new execution replaces its result; live ownership transfers keep their progress.
      child.subagent.task = { ...child.subagent.task, result: null };
      child.subagent.assistantText = "";
      child.subagent.assistantMessages.clear();
    }
    child.status = status;
    child.result = result;
  };
  const nativeChildOwner = (sessionId: string): AcpNativeChildSession | undefined => {
    const visited = new Set<string>();
    let child = ctx.nativeChildren.get(sessionId);
    while (child !== undefined && !visited.has(sessionId)) {
      if (child.subagent !== undefined) return child;
      visited.add(sessionId);
      if (child.parentSessionId === null) return;
      sessionId = child.parentSessionId;
      child = ctx.nativeChildren.get(sessionId);
    }
  };
  const hasWorkingDescendant = (sessionId: string) => {
    for (const [id, child] of ctx.nativeChildren) {
      if (id === sessionId || child.status !== "running") continue;
      const visited = new Set<string>();
      let parent = child.parentSessionId;
      while (parent !== null && !visited.has(parent)) {
        if (parent === sessionId) return true;
        visited.add(parent);
        parent = ctx.nativeChildren.get(parent)?.parentSessionId ?? null;
      }
    }
    return false;
  };
  ctx.late.publishNativeChildStatus = Effect.fnUntraced(function* (
    child: AcpNativeChildSession,
    status: AcpAdapterV2SubagentUpdate["status"],
  ) {
    const { subagent, owner } = child;
    if (subagent === undefined || owner === undefined) return;
    if (acpSubagentStatusIsTerminal(status)) yield* ctx.terminalizeSubagentTools(subagent);
    yield* ctx.emitSubagent(owner, {
      nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
      childSessionId: subagent.childSessionId,
      prompt: subagent.task.prompt,
      title: subagent.task.title,
      model: subagent.task.model,
      status,
      result: child.result,
    });
  });
  const syncNativeChildren = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
  ): Effect.fn.Return<void> {
    const rootSessionId = yield* Ref.get(ctx.activeSessionId);
    for (const [sessionId, child] of ctx.nativeChildren) {
      if (child.parentSessionId !== rootSessionId) continue;
      if (child.subagent === undefined && child.delegationId !== null) {
        const subagent = context.subagents.get(child.delegationId);
        if (subagent !== undefined) {
          child.subagent = subagent;
          child.owner = context;
          yield* ctx.emitSubagent(context, {
            nativeTaskId: child.delegationId,
            childSessionId: sessionId,
            prompt: subagent.task.prompt,
            title: subagent.task.title,
            model: subagent.task.model,
            status: "running",
            result: child.result,
          });
        }
      }
      const subagent = child.subagent;
      if (subagent === undefined) continue;
      const newDelegation =
        child.delegationId !== null &&
        child.delegationId !== subagent.task.nativeTaskRef?.nativeId &&
        !subagent.childItemOrdinals.has(`${sessionId}:prompt:${child.delegationId}`);
      if (newDelegation && child.status !== "running")
        setNativeChildState(child, "running", null);
      const hasNativeWork = child.status === "running" || hasWorkingDescendant(sessionId);
      if (
        (hasNativeWork && acpSubagentStatusIsTerminal(subagent.task.status)) ||
        (child.owner !== context &&
          (child.owner?.finalizedStatus !== "completed" || newDelegation) &&
          (hasNativeWork || child.pending.length > 0))
      ) {
        // The ownership event precedes child tools so the old run can detach first.
        child.owner = context;
        subagent.task = {
          ...subagent.task,
          runId: context.input.runId,
          parentNodeId: context.input.rootNodeId,
          status: "running",
          completedAt: null,
        };
        subagent.providerTurnId = context.providerTurnId;
        subagent.turnItemOrdinal = yield* ctx.resolveItemOrdinal(
          context,
          subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
        );
        subagent.terminalStatusProjected = false;
        context.subagents.set(
          subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
          subagent,
        );
        context.subagentsBySessionId.set(sessionId, subagent);
        yield* ctx.late.publishNativeChildStatus(child, "running");
        for (const [key, tool] of subagent.toolState.tools) {
          const toolSessionId = subagent.toolSessionIds.get(key);
          if (
            toolSessionId === undefined ||
            (toolStatus(tool.status) !== "running" && toolStatus(tool.status) !== "pending")
          )
            continue;
          subagent.toolState.toolUpdatesSkipped.delete(key);
          yield* ctx.projectSubagentTool(subagent, toolSessionId, tool, toolStatus(tool.status));
        }
      }
      if (
        child.delegationId !== null &&
        child.delegationId !== subagent.task.nativeTaskRef?.nativeId
      ) {
        const nativeItemId = `${sessionId}:prompt:${child.delegationId}`;
        if (!subagent.childItemOrdinals.has(nativeItemId)) {
          const now = yield* DateTime.now;
          const artifacts = makeSubagentConversationArtifacts({
            senderThreadId: subagent.task.threadId,
            messageId: ctx.providerMessageId(nativeItemId),
            turnItemId: ctx.providerTurnItemId(nativeItemId),
            threadId: subagent.childThreadId,
            rootNodeId: subagent.childRootNodeId,
            providerThreadId: subagent.task.providerThreadId,
            providerTurnId: null,
            nativeItemRef: { driver: ctx.driver, nativeId: nativeItemId, strength: "weak" },
            role: "user",
            text: child.prompt,
            ordinal: ctx.resolveSubagentChildOrdinal(subagent, nativeItemId),
            now,
          });
          yield* ctx.emitProviderEvent({
            type: "message.updated",
            driver: ctx.driver,
            message: artifacts.message,
          });
          yield* ctx.emitProviderEvent({
            type: "turn_item.updated",
            driver: ctx.driver,
            turnItem: artifacts.turnItem,
          });
        }
      }
    }
    for (const [sessionId, child] of ctx.nativeChildren) {
      const owner = nativeChildOwner(sessionId);
      if (owner?.owner !== context && owner?.owner?.finalizedStatus !== "completed") continue;
      for (const notification of child.pending.splice(0))
        yield* projectNativeChildFrame(notification);
      if (
        child.subagent?.childSessionId != null &&
        child.status !== "running" &&
        !hasWorkingDescendant(child.subagent.childSessionId)
      ) {
        yield* ctx.late.publishNativeChildStatus(child, child.status);
      }
    }
  });
  const projectNativeChildFrame = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
  ): Effect.fn.Return<void> {
    const child = nativeChild(notification.sessionId);
    const owner = nativeChildOwner(notification.sessionId);
    const subagent = owner?.subagent;
    if (
      subagent === undefined ||
      owner?.owner === undefined ||
      (owner.owner.finalized && owner.owner.finalizedStatus !== "completed") ||
      (acpSubagentStatusIsTerminal(subagent.task.status) && child.status === "running")
    ) {
      if (child.pending.length < 256) child.pending.push(notification);
      if (subagent !== undefined) {
        const root = yield* Ref.get(ctx.activeSessionId);
        if (root !== null) yield* ctx.late.offerContinuationRun(root);
      }
      return;
    }
    const update = notification.update;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      for (const event of parseSessionUpdateEvent(notification).events) {
        if (event._tag === "ToolCallUpdated") {
          const tool = ctx.flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
          yield* ctx.projectSubagentTool(
            subagent,
            notification.sessionId,
            tool,
            stoppedToolStatus(owner.owner, tool),
          );
        }
      }
    } else {
      yield* ctx.projectSubagentNotification(subagent, notification);
    }
  });
  const followNativeChild = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
    context: ActiveAcpTurn | null,
  ): Effect.fn.Return<boolean> {
    if (!ctx.followsAgentWorkState || ctx.flavor.extractSubagentSessionEvent === undefined)
      return false;
    const root = yield* Ref.get(ctx.activeSessionId);
    const event = ctx.flavor.extractSubagentSessionEvent(notification);
    if (event !== undefined) {
      if (yield* Ref.get(ctx.stoppedRunQuarantine)) return true;
      const child = nativeChild(event.childSessionId);
      child.parentSessionId = event.parentSessionId ?? child.parentSessionId;
      if (event.type === "state") {
        setNativeChildState(child, event.status, event.result);
      } else {
        child.delegationId = event.delegationId;
        child.prompt = event.prompt;
      }
      if (context !== null) yield* syncNativeChildren(context);
      const owner = nativeChildOwner(event.childSessionId);
      if (owner?.subagent !== undefined && owner.owner !== undefined) {
        const sessionId = owner.subagent.childSessionId;
        if (
          owner.status !== "running" &&
          sessionId !== null &&
          !hasWorkingDescendant(sessionId)
        ) {
          yield* ctx.late.publishNativeChildStatus(owner, owner.status);
        } else if (acpSubagentStatusIsTerminal(owner.subagent.task.status)) {
          if (context !== null) yield* syncNativeChildren(context);
          else if (root !== null) yield* ctx.late.offerContinuationRun(root);
        }
      }
      return true;
    }
    if (notification.sessionId === root) return false;
    if (yield* Ref.get(ctx.stoppedRunQuarantine)) return true;
    const update = notification.update;
    if (update.sessionUpdate === "state_update") {
      const child = nativeChild(notification.sessionId);
      setNativeChildState(
        child,
        update.state !== "idle"
          ? "running"
          : update.stopReason === "error"
            ? "failed"
            : update.stopReason === "cancelled"
              ? "cancelled"
              : "completed",
        update.state === "idle" ? (update.error?.message ?? null) : null,
      );
    }
    if (context !== null) yield* syncNativeChildren(context);
    yield* projectNativeChildFrame(notification);
    const owner = nativeChildOwner(notification.sessionId);
    if (
      owner?.subagent?.childSessionId != null &&
      owner.status !== "running" &&
      !hasWorkingDescendant(owner.subagent.childSessionId)
    ) {
      yield* ctx.late.publishNativeChildStatus(owner, owner.status);
    }
    return true;
  });
  return {
    nativeChild,
    setNativeChildState,
    nativeChildOwner,
    hasWorkingDescendant,
    syncNativeChildren,
    projectNativeChildFrame,
    followNativeChild,
  };
};
