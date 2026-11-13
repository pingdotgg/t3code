// ACP session behaviour extracted from server/adapter.ts (toolEmission).

import {
  acpSubagentStatusBlocksTurnSettlement,
  shouldPersistToolUpdate,
  type ActiveAcpTurn,
} from "./acpTurnModel.ts";
import {
  mergeToolCallState,
  extractMcpToolCallIdentity,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import {
  textFromUnknown,
  toolStatus,
  stoppedToolStatus,
  completedAtForStatus,
  nodeStatus,
  structuredFileChanges,
  pathFromToolCall,
  acpToolCallDiffPatch,
  commandExitCode,
  acpMcpToolCallOutput,
  acpBackendWebSearch,
  nonEmptyText,
  acpProjectedCommandExitCode,
  acpToolCallSnippetEdit,
  acpToolCallDiffUnpreviewable,
  type ProjectedToolStatus,
} from "./acpToolCallProjection.ts";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import { HTML_RENDER_TOOL_NAME } from "@t3tools/shared/htmlRender";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { unknownRecord } from "./clientPolicy.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx7 } from "./acpSessionContext.ts";

export const createAcpToolEmission = (ctx: AcpSessionCtx7) => {
  const toolOutputText = (toolCall: AcpToolCallState): string => {
    if (typeof toolCall.data.rawOutput === "string") {
      return toolCall.data.rawOutput;
    }
    if (
      typeof (toolCall.data.rawOutput as { text?: unknown } | undefined)?.text === "string"
    ) {
      return String((toolCall.data.rawOutput as { text: string }).text);
    }
    return textFromUnknown(toolCall.data.rawOutput) ?? "";
  };
  const setToolOutputText = (toolCall: AcpToolCallState, text: string): AcpToolCallState => ({
    ...toolCall,
    data: {
      ...toolCall.data,
      rawOutput: {
        type: "Text",
        text,
      },
    },
  });
  const appendToolOutputText = (
    toolCall: AcpToolCallState,
    appendOutput: string,
  ): AcpToolCallState => {
    if (appendOutput.length === 0) return toolCall;
    return setToolOutputText(toolCall, `${toolOutputText(toolCall)}${appendOutput}`);
  };
  const isMonitorEndNoticeText = (text: string): boolean =>
    /Monitor\s+["']?[0-9a-f-]{8,}/i.test(text) && /ended/i.test(text);
  const hasDeferredBackgroundWork = (context: ActiveAcpTurn): boolean => {
    if (context.awaitingBackgroundHydration.size > 0) return true;
    if (context.pendingInjectedReport.size > 0) return true;
    for (const [taskId, toolCallId] of context.toolCallIdsByBackgroundTaskId) {
      if (context.persistentBackgroundTaskIds.has(taskId)) continue;
      const tool = context.tools.get(toolCallId);
      if (tool === undefined) continue;
      const status = toolStatus(tool.status);
      if (status === "pending" || status === "running") return true;
    }
    for (const subagent of context.subagents.values()) {
      if (acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) {
        return true;
      }
    }
    return false;
  };
  const hasSurvivingBackgroundWork = (context: ActiveAcpTurn): boolean =>
    [...context.toolCallIdsByBackgroundTaskId.values()].some((toolCallId) => {
      const tool = context.tools.get(toolCallId);
      const status = tool === undefined ? undefined : toolStatus(tool.status);
      return status === "pending" || status === "running";
    }) ||
    [...context.subagents.values()].some((subagent) =>
      acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
    );
  const rearmDeferredFinalize =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (context: ActiveAcpTurn) {
      if (!ctx.flavor.deferFinalizeForBackgroundWork) return;
      if (!context.promptSettled || context.finalized) return;
      if (hasDeferredBackgroundWork(context)) return;
      yield* ctx.scheduleDeferredFinalize(context);
    });
  let emitTool: (
    context: ActiveAcpTurn,
    incoming: AcpToolCallState,
    projectedStatus?: ProjectedToolStatus,
  ) => Effect.Effect<void> = () => Effect.void;
  const markAwaitingBackgroundHydration =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (context: ActiveAcpTurn, taskId: string) {
      if (context.awaitingBackgroundHydration.has(taskId)) return;
      context.awaitingBackgroundHydration.add(taskId);
      yield* Effect.gen(function* () {
        yield* Effect.sleep("60000 millis");
        if (context.finalized || !context.awaitingBackgroundHydration.has(taskId)) return;
        context.awaitingBackgroundHydration.delete(taskId);
        const toolCallId = context.toolCallIdsByBackgroundTaskId.get(taskId);
        const tool = toolCallId !== undefined ? context.tools.get(toolCallId) : undefined;
        if (tool !== undefined) {
          const status = toolStatus(tool.status);
          if (status === "pending" || status === "running") {
            yield* emitTool(context, { ...tool, status: "completed" });
          }
        }
        yield* rearmDeferredFinalize(context);
      }).pipe(Effect.forkIn(ctx.sessionScope), Effect.asVoid);
    });
  const markPendingInjectedReport =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (context: ActiveAcpTurn, taskId: string) {
      if (!context.promptSettled) return;
      if (context.pendingInjectedReport.has(taskId)) return;
      context.pendingInjectedReport.add(taskId);
      yield* Effect.gen(function* () {
        yield* Effect.sleep("25000 millis");
        if (context.finalized || !context.pendingInjectedReport.has(taskId)) return;
        context.pendingInjectedReport.delete(taskId);
        yield* rearmDeferredFinalize(context);
      }).pipe(Effect.forkIn(ctx.sessionScope), Effect.asVoid);
    });
  const clearMidTurnUnreportedTaskIds = (taskIds: ReadonlyArray<string>) =>
    Ref.update(ctx.midTurnUnreportedCompletedTaskIds, (current) => {
      let next: Set<string> | null = null;
      for (const taskId of taskIds) {
        if (!current.has(taskId)) continue;
        if (next === null) next = new Set(current);
        next.delete(taskId);
      }
      return next ?? current;
    });
  emitTool = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    incoming: AcpToolCallState,
    projectedStatus?: ProjectedToolStatus,
  ) {
    if (context.assistant.current?.sourceMessageId == null)
      yield* ctx.closeTextStream(context, "assistant");
    if (context.reasoning.current?.sourceMessageId == null)
      yield* ctx.closeTextStream(context, "reasoning");
    yield* ctx.closeTextStream(context, "user");
    const previous = context.tools.get(incoming.toolCallId);
    const merged = mergeToolCallState(previous, incoming);
    const normalized = ctx.flavor.normalizeToolCall?.(merged) ?? merged;
    const backgroundTaskId = ctx.flavor.extractBackgroundTaskId?.(normalized);
    const backgroundCommandTaskId =
      ctx.flavor.isBackgroundCommandTool?.(normalized) === true
        ? backgroundTaskId
        : previous?.backgroundCommandTaskId;
    if (
      backgroundCommandTaskId !== undefined &&
      !context.backgroundCommands.has(backgroundCommandTaskId)
    ) {
      context.backgroundCommands.set(backgroundCommandTaskId, null);
    }
    const completion =
      context.promptSettled && backgroundCommandTaskId !== undefined
        ? (context.backgroundCommands.get(backgroundCommandTaskId) ?? undefined)
        : undefined;
    // Preserve hydrated output; only a replayed start ACK needs its output restored.
    const toolCall =
      completion === undefined
        ? normalized
        : {
            ...(backgroundTaskId === undefined || completion.output === undefined
              ? normalized
              : setToolOutputText(normalized, completion.output)),
            status: completion.status,
          };
    context.tools.set(
      toolCall.toolCallId,
      backgroundCommandTaskId === undefined
        ? toolCall
        : { ...toolCall, backgroundCommandTaskId },
    );
    if (
      ctx.followsAgentWorkState &&
      projectedStatus === undefined &&
      ctx.flavor.isProvisionalSubagentTool?.(toolCall)
    ) {
      yield* rearmDeferredFinalize(context);
      return;
    }
    if (backgroundTaskId !== undefined) {
      context.toolCallIdsByBackgroundTaskId.set(backgroundTaskId, toolCall.toolCallId);
      if (ctx.flavor.isPersistentBackgroundTool?.(toolCall) === true) {
        context.persistentBackgroundTaskIds.add(backgroundTaskId);
      }
      const backgroundStatus = projectedStatus ?? toolStatus(toolCall.status);
      yield* ctx.setBackgroundTaskRunning(
        backgroundTaskId,
        backgroundStatus === "pending" || backgroundStatus === "running",
      );
      if (
        !context.promptSettled &&
        backgroundStatus !== "pending" &&
        backgroundStatus !== "running"
      ) {
        yield* Ref.update(ctx.handledBackgroundTaskIdsInActiveTurn, (current) =>
          new Set(current).add(backgroundTaskId),
        );
        yield* Ref.update(ctx.midTurnUnreportedCompletedTaskIds, (current) => {
          if (!current.has(backgroundTaskId)) return current;
          const next = new Set(current);
          next.delete(backgroundTaskId);
          return next;
        });
      }
    }

    const backgroundCompletions =
      projectedStatus === undefined
        ? (ctx.flavor.extractBackgroundTaskCompletion?.(toolCall) ?? [])
        : [];
    let hydratedRegisteredMonitor = false;
    for (const backgroundCompletion of backgroundCompletions) {
      yield* ctx.applyBackgroundTaskMutationRunning(backgroundCompletion);
      if (backgroundCompletion.status !== "running") {
        yield* Ref.update(ctx.handledBackgroundTaskIdsInActiveTurn, (current) =>
          new Set(current).add(backgroundCompletion.taskId),
        );
        yield* Ref.update(ctx.midTurnUnreportedCompletedTaskIds, (current) => {
          if (!current.has(backgroundCompletion.taskId)) return current;
          const next = new Set(current);
          next.delete(backgroundCompletion.taskId);
          return next;
        });
      }
      if (backgroundCompletion.status !== "running") {
        context.awaitingBackgroundHydration.delete(backgroundCompletion.taskId);
      }
      const targetToolCallId = context.toolCallIdsByBackgroundTaskId.get(
        backgroundCompletion.taskId,
      );
      if (targetToolCallId !== undefined) {
        hydratedRegisteredMonitor = true;
      }
      const target =
        targetToolCallId !== undefined ? context.tools.get(targetToolCallId) : undefined;
      if (target !== undefined && target.toolCallId !== toolCall.toolCallId) {
        const nextStatus =
          backgroundCompletion.status === "running"
            ? ("inProgress" as const)
            : backgroundCompletion.status === "failed"
              ? ("failed" as const)
              : ("completed" as const);
        const hydrated =
          backgroundCompletion.appendOutput.length > 0
            ? isMonitorEndNoticeText(toolOutputText(target)) ||
              toolOutputText(target).trim().length === 0
              ? setToolOutputText(
                  { ...target, status: nextStatus },
                  backgroundCompletion.appendOutput,
                )
              : appendToolOutputText(
                  { ...target, status: nextStatus },
                  backgroundCompletion.appendOutput,
                )
            : { ...target, status: nextStatus };
        // BackgroundTaskStarted normalization can reopen this row, so keep the
        // completion for settlement when no task_completed recorded one.
        if (
          backgroundCompletion.status !== "running" &&
          context.backgroundCommands.get(backgroundCompletion.taskId) === null
        ) {
          context.backgroundCommands.set(backgroundCompletion.taskId, {
            status: backgroundCompletion.status,
            output: toolOutputText(hydrated),
          });
        }
        yield* emitTool(context, hydrated);
      }
    }

    // Monitor TaskOutput resembles subagent hydration; do not invent a subagent.
    const subagentUpdate = hydratedRegisteredMonitor
      ? undefined
      : ctx.extractSubagentUpdate(toolCall);
    if (subagentUpdate !== undefined) {
      yield* ctx.emitSubagent(context, subagentUpdate);
      if (ctx.followsAgentWorkState) yield* ctx.syncNativeChildren(context);
      if (subagentUpdate.suppressNormalTool !== false) {
        yield* rearmDeferredFinalize(context);
        return;
      }
    }
    if (
      projectedStatus === undefined &&
      !shouldPersistToolUpdate(
        context,
        toolCall.toolCallId,
        previous,
        toolCall,
        merged.status,
      )
    ) {
      yield* rearmDeferredFinalize(context);
      return;
    }
    const status =
      projectedStatus ?? stoppedToolStatus(context, toolCall) ?? toolStatus(toolCall.status);
    const now = yield* DateTime.now;
    const nativeItemId = `${context.nativeThreadId}:tool:${toolCall.toolCallId}`;
    const ordinal = yield* ctx.resolveItemOrdinal(context, nativeItemId);
    const nodeId = ctx.providerNodeId(nativeItemId);
    const turnItemId = ctx.providerTurnItemId(nativeItemId);
    const nativeItemRef = {
      driver: ctx.driver,
      nativeId: toolCall.toolCallId,
      strength: "strong" as const,
    };
    const startedAt = context.toolStartedAt.get(toolCall.toolCallId) ?? now;
    context.toolStartedAt.set(toolCall.toolCallId, startedAt);
    const completedAt = completedAtForStatus(status, now);
    const title = toolCall.title ?? null;
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node: {
        id: nodeId,
        threadId: context.input.threadId,
        runId: context.input.runId,
        parentNodeId: context.input.rootNodeId,
        rootNodeId: context.input.rootNodeId,
        kind: "tool_call",
        status: nodeStatus(status),
        countsForRun: true,
        providerThreadId: context.input.providerThread.id,
        providerTurnId: context.providerTurnId,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    });

    const base = {
      id: turnItemId,
      threadId: context.input.threadId,
      runId: context.input.runId,
      nodeId,
      providerThreadId: context.input.providerThread.id,
      providerTurnId: context.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal,
      status,
      title,
      startedAt,
      completedAt,
      updatedAt: now,
    } as const;
    const rawInput = toolCall.data.rawInput;
    const rawOutput = toolCall.data.rawOutput ?? toolCall.data.content;
    const changes = structuredFileChanges(toolCall);
    const path = changes[0]?.path ?? pathFromToolCall(toolCall);
    const diffText =
      acpToolCallDiffPatch(toolCall.data.content) ?? textFromUnknown(rawOutput);
    const rawInputRecord = unknownRecord(rawInput);
    const inputVariant =
      typeof rawInputRecord?.variant === "string"
        ? rawInputRecord.variant.trim().toLowerCase()
        : "";
    const rawOutputRecord = unknownRecord(rawOutput);
    const outputCommand =
      typeof rawOutputRecord?.command === "string" &&
      rawOutputRecord.command.trim().length > 0
        ? rawOutputRecord.command.trim()
        : undefined;
    const monitorCommand =
      (typeof rawInputRecord?.command === "string" && rawInputRecord.command.trim().length > 0
        ? rawInputRecord.command.trim()
        : undefined) ?? outputCommand;
    const outputIsBashResult =
      typeof rawOutputRecord?.type === "string" &&
      rawOutputRecord.type.trim().toLowerCase() === "bash" &&
      commandExitCode(rawOutput) !== undefined;
    const projectAsCommandExecution = inputVariant === "monitor" || outputIsBashResult;
    const mcpIdentity = extractMcpToolCallIdentity(toolCall, {
      embeddedTerminalCommands: ctx.embeddedTerminalCommands(
        context.nativeThreadId,
        toolCall.toolCallId,
      ),
    });
    let turnItem: OrchestrationV2TurnItem;
    if (toolCall.toolCallId.startsWith("acp-compaction:")) {
      const summary = textFromUnknown(rawOutput);
      turnItem = {
        ...base,
        type: "compaction",
        driver: ctx.driver,
        ...(summary === undefined ? {} : { summary }),
        ...(context.contextUsage?.usedTokens === undefined
          ? {}
          : { beforeTokenCount: context.contextUsage.usedTokens }),
      };
      if (status === "completed") {
        context.contextUsage = null;
        yield* Ref.update(ctx.contextUsageBySessionId, (current) => {
          const updated = new Map(current);
          updated.delete(context.nativeThreadId);
          return updated;
        });
        yield* Ref.update(ctx.compactionMarkers, (current) => {
          const updated = new Map(current);
          updated.set(context.nativeThreadId, Symbol());
          return updated;
        });
      }
    } else if (mcpIdentity !== undefined) {
      const toolName = `${mcpIdentity.server}.${mcpIdentity.tool}`;
      const input =
        mcpIdentity.input ?? unknownRecord(rawInputRecord?.arguments) ?? rawInputRecord ?? {};
      let output = rawOutput === undefined ? undefined : acpMcpToolCallOutput(rawOutput);
      const isHtmlRender = resolveT3McpToolId(toolName) === HTML_RENDER_TOOL_NAME;
      const isError =
        compactDynamicToolOutput(output)?.isError === true ||
        compactDynamicToolOutput(rawOutputRecord?.result)?.isError === true;
      if (
        isHtmlRender &&
        (status === "failed" || (status === "completed" && isError)) &&
        previous?.status !== "failed" &&
        previous?.status !== "completed"
      ) {
        // A failed call may have published before the provider lost its result.
        yield* ctx.mcpSessions.takeHtmlRender(
          context.input.threadId,
          input,
          htmlRenderFromToolItem({ toolName, output }),
        );
      }
      if (status === "completed" && isHtmlRender && !isError) {
        const reportedPage = htmlRenderFromToolItem({ toolName, output });
        // Antigravity replaces MCP results with summaries, including on repeated completions.
        const previousPage = htmlRenderFromToolItem({
          toolName,
          output: acpMcpToolCallOutput(previous?.data.rawOutput ?? previous?.data.content),
        });
        const page = reportedPage
          ? yield* ctx.mcpSessions.takeHtmlRender(context.input.threadId, input, reportedPage)
          : (previousPage ??
            (yield* ctx.mcpSessions.takeHtmlRender(context.input.threadId, input)));
        if (reportedPage === undefined && page !== undefined) {
          output = { htmlRender: page };
          context.tools.set(toolCall.toolCallId, {
            ...toolCall,
            data: { ...toolCall.data, rawOutput: output },
          });
        }
      }
      turnItem = {
        ...base,
        title: null,
        ...mcpToolPresentation({
          serverName: mcpIdentity.server,
          toolName: mcpIdentity.tool,
          source: unknownRecord(
            (unknownRecord(rawOutputRecord?.result) ?? rawOutputRecord)?._meta,
          )?.source,
        }),
        type: "dynamic_tool",
        toolName,
        input,
        ...(output === undefined ? {} : { output }),
      };
      yield* ctx.emitProviderEvent({ type: "turn_item.updated", driver: ctx.driver, turnItem });
      yield* rearmDeferredFinalize(context);
      return;
    } else if (changes.length > 0) {
      turnItem = {
        ...base,
        type: "file_change",
        fileName: changes[0]!.path,
        changes,
        ...(diffText === undefined ? {} : { diffStr: diffText }),
      };
    } else {
      switch (toolCall.kind) {
        case "read":
          turnItem = {
            ...base,
            title: path ? formatReadToolLabel(path) : (title ?? "Read file"),
            type: "dynamic_tool",
            toolName: "Read",
            input:
              path === undefined ||
              ["path", "filePath", "file_path"].some((key) => rawInputRecord?.[key] === path)
                ? (rawInputRecord ?? {})
                : { ...rawInputRecord, path },
            ...(rawOutput === undefined ? {} : { output: rawOutput }),
          };
          break;
        case "search": {
          const backendSearch = acpBackendWebSearch(rawInputRecord, rawOutputRecord);
          if (backendSearch !== undefined) {
            const label = nonEmptyText(toolCall.data.title, title ?? "Web search").replace(
              /:\s*$/u,
              "",
            );
            turnItem = {
              ...base,
              title:
                backendSearch.query === undefined
                  ? label
                  : `${label}: ${backendSearch.query}`,
              type: "web_search",
              ...(backendSearch.query === undefined
                ? {}
                : { patterns: [backendSearch.query] }),
              ...(backendSearch.results.length === 0
                ? {}
                : { results: backendSearch.results }),
            };
            break;
          }
          turnItem = {
            ...base,
            title:
              formatSearchToolLabel({
                rawInput: rawInputRecord,
                input: rawInputRecord,
                ...(path === undefined ? {} : { pattern: path }),
              }) ?? title,
            type: "file_search",
            ...(path === undefined ? {} : { pattern: path }),
            ...(path === undefined
              ? {}
              : {
                  results: [
                    {
                      fileName: path,
                      ...(textFromUnknown(rawOutput) === undefined
                        ? {}
                        : { preview: textFromUnknown(rawOutput) }),
                    },
                  ],
                }),
          };
          break;
        }
        case "execute": {
          const exitCode = acpProjectedCommandExitCode(status, rawOutput);
          turnItem = {
            ...base,
            type: "command_execution",
            input: toolCall.command ?? monitorCommand ?? toolCall.title ?? "Command",
            ...(textFromUnknown(rawOutput) === undefined
              ? {}
              : { output: textFromUnknown(rawOutput) }),
            ...(exitCode === undefined ? {} : { exitCode }),
          };
          break;
        }
        case "edit":
        case "delete":
        case "move": {
          const snippet = acpToolCallSnippetEdit(toolCall.data.content);
          const unpreviewable = acpToolCallDiffUnpreviewable(toolCall.data.content);
          turnItem = {
            ...base,
            type: "file_change",
            fileName: path ?? toolCall.title ?? "File change",
            ...(snippet ??
              (unpreviewable || diffText === undefined ? {} : { diffStr: diffText })),
          };
          break;
        }
        case "fetch": {
          // Grok rawOutput.Content is unreadable by textFromUnknown; bounded content blocks duplicate it.
          const snippet =
            textFromUnknown(toolCall.data.content) ?? textFromUnknown(rawOutput);
          turnItem = {
            ...base,
            type: "web_search",
            ...(path === undefined ? {} : { patterns: [path] }),
            ...(path === undefined
              ? {}
              : {
                  results: [
                    {
                      url: path,
                      ...(snippet === undefined ? {} : { snippet }),
                    },
                  ],
                }),
          };
          break;
        }
        default:
          if (projectAsCommandExecution) {
            const exitCode = acpProjectedCommandExitCode(status, rawOutput);
            turnItem = {
              ...base,
              type: "command_execution",
              input:
                toolCall.command ??
                monitorCommand ??
                toolCall.title ??
                (inputVariant === "monitor" ? "Monitor" : "Command"),
              ...(textFromUnknown(rawOutput) === undefined
                ? {}
                : { output: textFromUnknown(rawOutput) }),
              ...(exitCode === undefined ? {} : { exitCode }),
              ...(inputVariant === "monitor" ? { monitor: true } : {}),
            };
          } else {
            turnItem = {
              ...base,
              type: "dynamic_tool",
              toolName: toolCall.title ?? toolCall.kind ?? null,
              input: rawInput ?? {},
              ...(rawOutput === undefined ? {} : { output: rawOutput }),
            };
          }
      }
    }
    yield* ctx.emitProviderEvent({ type: "turn_item.updated", driver: ctx.driver, turnItem });
    yield* rearmDeferredFinalize(context);
  });
  return {
    toolOutputText,
    setToolOutputText,
    appendToolOutputText,
    isMonitorEndNoticeText,
    hasDeferredBackgroundWork,
    hasSurvivingBackgroundWork,
    rearmDeferredFinalize,
    markAwaitingBackgroundHydration,
    markPendingInjectedReport,
    clearMidTurnUnreportedTaskIds,
    get emitTool() {
      return emitTool;
    },
    set emitTool(value) {
      emitTool = value;
    },
  };
};
