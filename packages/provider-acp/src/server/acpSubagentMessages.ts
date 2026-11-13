// ACP session behaviour extracted from server/adapter.ts (subagentMessages).

import {
  acpContentBlockDisplayText,
  mergeToolCallState,
  extractMcpToolCallIdentity,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import {
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  shouldPersistToolUpdate,
  type ActiveAcpTurn,
  type ActiveAcpSubagent,
} from "./acpTurnModel.ts";
import {
  toolStatus,
  completedAtForStatus,
  type ProjectedToolStatus,
} from "./acpToolCallProjection.ts";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import { unknownRecord } from "./clientPolicy.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx4 } from "./acpSessionContext.ts";

export const createAcpSubagentMessages = (ctx: AcpSessionCtx4) => {
  const appendText = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    kind: "user" | "assistant" | "reasoning",
    text: string,
    messageId?: string | null,
  ) {
    if (text.length === 0) return;
    for (const other of ["user", "reasoning", "assistant"] as const) {
      if (other !== kind) yield* ctx.closeTextStream(context, other);
    }
    const stream = ctx.textStreamFor(context, kind);
    const sourceMessageId = messageId?.trim() || null;
    if (
      stream.current !== null &&
      sourceMessageId !== null &&
      stream.current.sourceMessageId !== null &&
      stream.current.sourceMessageId !== sourceMessageId
    ) {
      yield* ctx.closeTextStream(context, kind);
    }
    if (stream.current === null) {
      const now = yield* DateTime.now;
      stream.current = {
        nativeItemId:
          sourceMessageId === null
            ? `${context.nativeTurnId}:${kind}:${stream.nextSegment}`
            : `${context.nativeTurnId}:${kind}:message:${sourceMessageId}`,
        startedAt: now,
        sourceMessageId,
        text: "",
        emitted: false,
        dirty: false,
      };
      stream.nextSegment += 1;
    } else if (stream.current.sourceMessageId === null && sourceMessageId !== null) {
      // Agents may omit the first messageId; retain projected identity until the first later id.
      stream.current.sourceMessageId = sourceMessageId;
    }
    stream.current.text += text;
    yield* ctx.publishTextSegment(context, kind);
  });
  const replaceText = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    kind: "user" | "assistant" | "reasoning",
    text: string,
    messageId: string,
  ) {
    for (const other of ["user", "reasoning", "assistant"] as const) {
      if (other !== kind) yield* ctx.closeTextStream(context, other);
    }
    const stream = ctx.textStreamFor(context, kind);
    if (stream.current?.sourceMessageId !== messageId) {
      yield* ctx.closeTextStream(context, kind);
      const now = yield* DateTime.now;
      stream.current = {
        nativeItemId: `${context.nativeTurnId}:${kind}:message:${messageId}`,
        startedAt: now,
        sourceMessageId: messageId,
        text,
        emitted: false,
        dirty: false,
      };
      stream.nextSegment += 1;
    } else {
      stream.current.text = text;
    }
    yield* ctx.publishTextSegment(context, kind);
  });
  const emitSubagentAssistant = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    text: string,
    mode: "append" | "replace" = "append",
    messageId?: string | null,
  ) {
    if (text.length === 0 && mode === "append") return;
    const nativeItemId = `${subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id}:message:${messageId ?? "result"}`;
    const previous = subagent.assistantMessages.get(nativeItemId) ?? "";
    const messageText = mode === "replace" ? text : `${previous}${text}`;
    subagent.assistantMessages.set(nativeItemId, messageText);
    subagent.assistantText = messageText;
    const now = yield* DateTime.now;
    const ordinal = ctx.resolveSubagentChildOrdinal(subagent, nativeItemId);
    const artifacts = makeSubagentConversationArtifacts({
      messageId: ctx.providerMessageId(nativeItemId),
      turnItemId: ctx.providerTurnItemId(nativeItemId),
      threadId: subagent.childThreadId,
      rootNodeId: subagent.childRootNodeId,
      providerThreadId: subagent.task.providerThreadId,
      providerTurnId: null,
      nativeItemRef: { driver: ctx.driver, nativeId: nativeItemId, strength: "weak" },
      role: "assistant",
      text: subagent.assistantText,
      ordinal,
      now,
    });
    yield* ctx.emitProviderEvent({ type: "message.updated", driver: ctx.driver, message: artifacts.message });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: artifacts.turnItem,
    });
  });
  const projectSubagentNotification = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    notification: EffectAcpSchema.SessionNotification,
  ) {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = acpContentBlockDisplayText(update.content);
      if (text !== undefined) {
        yield* emitSubagentAssistant(subagent, text, "append", update.messageId);
      }
    } else if (update.sessionUpdate === "agent_message") {
      if (update.content === undefined) return;
      const text = (update.content ?? [])
        .flatMap((content) => {
          const display = acpContentBlockDisplayText(content);
          return display === undefined ? [] : [display];
        })
        .join("\n");
      yield* emitSubagentAssistant(subagent, text, "replace", update.messageId);
    }
  });
  const projectSubagentTool = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    sessionId: string,
    toolCall: AcpToolCallState,
    projectedStatus?: ProjectedToolStatus,
  ) {
    const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
    const key =
      sessionId === subagent.childSessionId
        ? `${nativeTaskId}:tool:${toolCall.toolCallId}`
        : `${nativeTaskId}:session:${sessionId}:tool:${toolCall.toolCallId}`;
    const context = subagent.toolState;
    const rootSessionId = yield* Ref.get(ctx.activeSessionId);
    subagent.toolSessionIds.set(key, sessionId);
    const previous = context.tools.get(key);
    const merged = mergeToolCallState(previous, toolCall);
    context.tools.set(key, merged);
    if (
      projectedStatus === undefined &&
      !shouldPersistToolUpdate(context, key, previous, merged, merged.status)
    )
      return;
    const mcpIdentity = extractMcpToolCallIdentity(merged, {
      embeddedTerminalCommands: [
        ...ctx.embeddedTerminalCommands(sessionId, toolCall.toolCallId),
        ...(rootSessionId === null
          ? []
          : ctx.embeddedTerminalCommands(rootSessionId, toolCall.toolCallId)),
      ],
    });
    const now = yield* DateTime.now;
    const status = projectedStatus ?? toolStatus(merged.status);
    const startedAt = context.toolStartedAt.get(key) ?? now;
    context.toolStartedAt.set(key, startedAt);
    const ordinal = ctx.resolveSubagentChildOrdinal(subagent, key);
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem: {
        id: ctx.providerTurnItemId(key),
        threadId: subagent.childThreadId,
        runId: null,
        nodeId: subagent.childRootNodeId,
        providerThreadId: subagent.task.providerThreadId,
        providerTurnId: null,
        nativeItemRef: { driver: ctx.driver, nativeId: key, strength: "strong" },
        parentItemId: null,
        ordinal,
        status,
        title: merged.title ?? merged.kind ?? "Tool",
        startedAt,
        completedAt: completedAtForStatus(status, now),
        updatedAt: now,
        type: "dynamic_tool",
        ...(mcpIdentity === undefined
          ? {}
          : mcpToolPresentation({
              serverName: mcpIdentity.server,
              toolName: mcpIdentity.tool,
              source: unknownRecord(
                (
                  unknownRecord(unknownRecord(merged.data.rawOutput)?.result) ??
                  unknownRecord(merged.data.rawOutput)
                )?._meta,
              )?.source,
            })),
        toolName:
          mcpIdentity === undefined
            ? (merged.title ?? merged.kind ?? "Tool")
            : `${mcpIdentity.server}.${mcpIdentity.tool}`,
        input: merged.data.rawInput ?? null,
        output: merged.data.rawOutput ?? merged.data.content ?? null,
      },
    });
  });
  const terminalizeSubagentTools = Effect.fnUntraced(function* (subagent: ActiveAcpSubagent) {
    for (const [key, tool] of subagent.toolState.tools) {
      if (
        toolStatus(tool.status) !== "running" &&
        toolStatus(tool.status) !== "pending" &&
        toolStatus(tool.status) !== "waiting"
      )
        continue;
      const sessionId = subagent.toolSessionIds.get(key);
      if (sessionId !== undefined)
        yield* projectSubagentTool(
          subagent,
          sessionId,
          { ...tool, status: "failed" },
          "interrupted",
        );
    }
  });
  return {
    appendText,
    replaceText,
    emitSubagentAssistant,
    projectSubagentNotification,
    projectSubagentTool,
    terminalizeSubagentTools,
  };
};
