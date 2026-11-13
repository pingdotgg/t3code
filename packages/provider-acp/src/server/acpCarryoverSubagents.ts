// ACP session behaviour extracted from server/adapter.ts (carryoverSubagents).

import {
  acpSubagentStatusIsTerminal,
  acpSubagentStatusBlocksTurnSettlement,
  type ActiveAcpSubagent,
  type ActiveAcpTurn,
  type AcpCarryoverSubagents,
} from "./acpTurnModel.ts";
import { parseSessionUpdateEvent } from "./runtimeModel.ts";
import { type AcpAdapterV2SubagentUpdate } from "./acpAdapterConfig.ts";
import { type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx13 } from "./acpSessionContext.ts";

export const createAcpCarryoverSubagents = (ctx: AcpSessionCtx13) => {
  const mutateCarryoverSubagentStatus = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    status: OrchestrationV2Subagent["status"],
    resultOverride?: string | null,
  ) {
    const now = yield* DateTime.now;
    const result =
      resultOverride !== undefined && resultOverride !== null && resultOverride.length > 0
        ? resultOverride
        : (subagent.task.result ?? (subagent.assistantText || null));
    const completedAt = acpSubagentStatusIsTerminal(status) ? now : null;
    subagent.task = {
      ...subagent.task,
      status,
      result,
      completedAt,
      updatedAt: now,
    };
  });
  const projectCarryoverSubagentStatus = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    status: OrchestrationV2Subagent["status"],
    resultOverride?: string | null,
  ) {
    yield* mutateCarryoverSubagentStatus(subagent, status, resultOverride);
    const now = subagent.task.updatedAt;
    const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id;
    const nativeItemRef = {
      driver: ctx.driver,
      nativeId: nativeTaskId,
      strength: "strong" as const,
    };
    const parentProviderThreadId = subagent.parentProviderThreadId;
    const result = subagent.task.result;
    const completedAt = subagent.task.completedAt;
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: subagent.task.id,
        threadId: subagent.task.threadId,
        runId: subagent.task.runId,
        parentNodeId: subagent.task.parentNodeId,
        rootNodeId: subagent.task.parentNodeId,
        kind: "subagent",
        status,
        countsForRun: false,
        providerThreadId: parentProviderThreadId,
        providerTurnId: subagent.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: subagent.task.startedAt,
        completedAt,
      },
    });
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: subagent.childRootNodeId,
        threadId: subagent.childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: subagent.childRootNodeId,
        kind: "root_turn",
        status,
        countsForRun: false,
        providerThreadId: subagent.task.providerThreadId,
        providerTurnId: null,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: subagent.task.startedAt,
        completedAt,
      },
    });
    yield* ctx.emitProviderEvent({
      type: "subagent.updated",
      driver: ctx.driver,
      subagent: subagent.task,
    });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: {
        id: subagent.turnItemId,
        threadId: subagent.task.threadId,
        runId: subagent.task.runId,
        nodeId: subagent.task.id,
        providerThreadId: parentProviderThreadId,
        providerTurnId: subagent.providerTurnId,
        nativeItemRef,
        parentItemId: null,
        ordinal: subagent.turnItemOrdinal,
        status,
        title: subagent.task.title,
        startedAt: subagent.task.startedAt,
        completedAt,
        updatedAt: now,
        type: "subagent",
        subagentId: subagent.task.id,
        origin: "provider_native",
        driver: ctx.driver,
        providerInstanceId: subagent.task.providerInstanceId,
        childThreadId: subagent.childThreadId,
        prompt: subagent.task.prompt,
        result,
      },
    });
    if (acpSubagentStatusIsTerminal(status)) {
      subagent.terminalStatusProjected = true;
    }
  });
  ctx.late.updateCarryoverSubagentStatus = Effect.fnUntraced(function* (
    nativeIdOrChildSessionId: string,
    status: OrchestrationV2Subagent["status"],
    result?: string | null,
    options?: { readonly project?: boolean },
  ) {
    const carryover = yield* Ref.get(ctx.carryoverSubagents);
    if (carryover === null) return false;
    const match = carryover.subagents.find((subagent) => {
      const nativeId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
      return (
        nativeId === nativeIdOrChildSessionId ||
        subagent.childSessionId === nativeIdOrChildSessionId
      );
    });
    if (match === undefined) return false;
    const shouldProject = options?.project !== false;
    if (match.task.status === status) {
      if (!shouldProject || match.terminalStatusProjected) {
        return true;
      }
      yield* projectCarryoverSubagentStatus(match, status, result);
      return true;
    }
    if (match.task.status !== "running" && match.task.status !== "pending") {
      return false;
    }
    if (!shouldProject) {
      yield* mutateCarryoverSubagentStatus(match, status, result);
    } else {
      yield* projectCarryoverSubagentStatus(match, status, result);
    }
    return true;
  });
  const finishSubagentFromNotice = Effect.fnUntraced(function* (notice: {
    readonly childSessionId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly result: string | null;
  }) {
    const context = yield* Ref.get(ctx.activeTurn);
    const subagent =
      context === null ? undefined : context.subagentsBySessionId.get(notice.childSessionId);
    const known =
      subagent ??
      (yield* Ref.get(ctx.carryoverSubagents))?.subagents.find(
        (candidate) =>
          candidate.childSessionId === notice.childSessionId ||
          candidate.task.nativeTaskRef?.nativeId === notice.childSessionId,
      );
    if (known !== undefined && acpSubagentStatusBlocksTurnSettlement(known.task.status)) {
      yield* ctx.recordWakeReport(notice.childSessionId, {
        kind: "subagent",
        label: known.task.title ?? known.task.prompt,
        outcome: notice.status,
        childThreadId: known.childThreadId,
      });
    }
    if (context !== null && subagent !== undefined && !context.finalized) {
      if (!acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) return;
      yield* ctx.emitSubagent(context, {
        nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? notice.childSessionId,
        prompt: subagent.task.prompt,
        title: subagent.task.title,
        model: subagent.task.model,
        status: notice.status,
        childSessionId: notice.childSessionId,
        result: notice.result,
        suppressNormalTool: true,
      });
      yield* ctx.rearmDeferredFinalize(context);
      return;
    }
    const carryover = yield* Ref.get(ctx.carryoverSubagents);
    yield* ctx.late.updateCarryoverSubagentStatus(
      notice.childSessionId,
      notice.status,
      notice.result,
      {
        project:
          carryover !== null &&
          carryover.sessionId === (yield* Ref.get(ctx.activeSessionId)) &&
          carryover.projectsLateTerminals,
      },
    );
  });
  ctx.applyFinalizedActiveTurnSubagentTerminal = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    notification: EffectAcpSchema.SessionNotification,
  ) {
    if (ctx.flavor.extractSubagentUpdate === undefined) return false;

    const applyTerminal = Effect.fnUntraced(function* (
      subagent: ActiveAcpSubagent,
      update: AcpAdapterV2SubagentUpdate,
    ) {
      if (!acpSubagentStatusIsTerminal(update.status)) return false;
      if (acpSubagentStatusIsTerminal(subagent.task.status)) {
        if (subagent.terminalStatusProjected || context.finalizedStatus !== "completed") {
          return true;
        }
      }
      if (context.finalizedStatus === "completed") {
        yield* ctx.emitSubagent(context, update);
      } else {
        yield* mutateCarryoverSubagentStatus(subagent, update.status, update.result);
      }
      return true;
    });

    const sessionUpdate = notification.update;
    if (
      sessionUpdate.sessionUpdate === "tool_call" ||
      sessionUpdate.sessionUpdate === "tool_call_update"
    ) {
      for (const event of parseSessionUpdateEvent(notification).events) {
        if (event._tag !== "ToolCallUpdated") continue;
        const toolCall = ctx.flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
        const subagentUpdate = ctx.extractSubagentUpdate(toolCall);
        if (
          subagentUpdate === undefined ||
          !acpSubagentStatusIsTerminal(subagentUpdate.status)
        ) {
          continue;
        }
        const subagent =
          context.subagents.get(subagentUpdate.nativeTaskId) ??
          (subagentUpdate.childSessionId === null
            ? undefined
            : context.subagentsBySessionId.get(subagentUpdate.childSessionId)) ??
          context.subagentsBySessionId.get(notification.sessionId);
        if (subagent === undefined) continue;
        const nativeTaskId =
          subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
        if (
          subagentUpdate.nativeTaskId !== nativeTaskId &&
          (subagentUpdate.childSessionId === null ||
            (subagentUpdate.childSessionId !== subagent.childSessionId &&
              subagentUpdate.childSessionId !== notification.sessionId))
        ) {
          continue;
        }
        if (yield* applyTerminal(subagent, subagentUpdate)) return true;
      }
    }

    if (
      sessionUpdate.sessionUpdate === "user_message_chunk" &&
      sessionUpdate.content.type === "text" &&
      ctx.flavor.extractSubagentEndNotice !== undefined
    ) {
      const notice = ctx.flavor.extractSubagentEndNotice(sessionUpdate.content.text);
      const subagent =
        notice === undefined
          ? undefined
          : context.subagentsBySessionId.get(notice.childSessionId);
      if (notice !== undefined && subagent !== undefined) {
        return yield* applyTerminal(subagent, {
          nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
          prompt: subagent.task.prompt,
          title: subagent.task.title,
          model: subagent.task.model,
          status: notice.status,
          childSessionId: notice.childSessionId,
          result: null,
          suppressNormalTool: true,
        });
      }
    }

    return false;
  });
  const projectDeferredCarryoverTerminals = Effect.fnUntraced(function* (
    subagents: ReadonlyArray<ActiveAcpSubagent>,
  ) {
    for (const subagent of subagents) {
      if (
        subagent.task.status === "running" ||
        subagent.task.status === "pending" ||
        subagent.terminalStatusProjected
      ) {
        continue;
      }
      yield* projectCarryoverSubagentStatus(
        subagent,
        subagent.task.status,
        subagent.task.result,
      );
    }
  });
  const terminalizeCarryoverSubagents = Effect.fnUntraced(function* (
    carryover: AcpCarryoverSubagents | null,
  ) {
    if (carryover === null) return;
    for (const subagent of carryover.subagents) {
      yield* ctx.terminalizeSubagentTools(subagent);
      if (acpSubagentStatusIsTerminal(subagent.task.status)) {
        if (!subagent.terminalStatusProjected) {
          yield* projectCarryoverSubagentStatus(
            subagent,
            subagent.task.status,
            subagent.task.result,
          );
        }
        continue;
      }
      yield* projectCarryoverSubagentStatus(subagent, "interrupted");
    }
  });
  return {
    mutateCarryoverSubagentStatus,
    projectCarryoverSubagentStatus,
    finishSubagentFromNotice,
    projectDeferredCarryoverTerminals,
    terminalizeCarryoverSubagents,
  };
};
