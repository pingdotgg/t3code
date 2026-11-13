/**
 * Pi tool call and subagent tool item projection.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import {
  PI_INHERIT_MODEL_SLUG,
  PI_PROVIDER,
  STREAM_FLUSH_MS,
  PI_REQUEST_TIMEOUT_MS,
  PI_SESSION_TIMEOUT_MS,
  PI_UNSOLICITED_ACTIVITY_ERROR,
  SETTLE_PROBE_MAX_ATTEMPTS,
  SETTLE_PROBE_RETRY_DELAY,
  PI_THINKING_LEVELS,
  PI_COMPACTING_PROMPT_REJECTION,
  PiProviderCapabilitiesV2,
  contentText,
  piToolOutput,
  providerRef,
  compactionTitle,
  piApprovalRequestKind,
} from "../adapter.ts";
import type {
  PiAdapterV2Options,
  PiStreamItemState,
  PiCompactionStatus,
  PiCompactionState,
  PiProviderRetryState,
  ActivePiTurn,
  PiTurnTreeRefs,
  PendingPiPrompt,
  PiPromptSend,
  PiThreadState,
  PiWake,
} from "../adapter.ts";
import { protocolError } from "./protocol.ts";
import {
  piExtensionDisplayName,
  piSubagentOutput,
} from "./projection.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";

export const makeTools = (deps: State & Emitters) => {
  const {
    options,
    input,
    idAllocator,
    now,
    outOfTurnExtensionErrors,
  } = deps;
  const m = deps.mutable;
  const emitToolItem = Effect.fnUntraced(function* (
    turn: ActivePiTurn,
    event: PiRpcRecord,
    phase: "start" | "update" | "end",
  ) {
    const toolCallId = recordString(event, "toolCallId");
    const toolName = recordString(event, "toolName") ?? "tool";
    // Pi tags every phase of a call made through ctx.executeTool, such as from a codemode script.
    const parentToolCallId = recordString(event, "parentToolCallId");
    if (toolCallId === undefined) return;
    if (phase === "start") {
      turn.toolArgs.set(toolCallId, event["args"]);
    }
    const args = event["args"] ?? turn.toolArgs.get(toolCallId);
    const emittedAt = yield* DateTime.now;
    const startedAt = turn.toolStartedAt.get(toolCallId) ?? emittedAt;
    turn.toolStartedAt.set(toolCallId, startedAt);
    const completed = phase === "end";
    const isError = event["isError"] === true;
    const resultRecord = completed ? event["result"] : event["partialResult"];
    const outputText = contentText(recordField(resultRecord, "content"));
    const status = completed
      ? isError
        ? turn.interrupted
          ? "interrupted"
          : "failed"
        : "completed"
      : "running";
    const base = deps.baseItemFields(turn, toolCallId, startedAt, emittedAt, parentToolCallId);
    yield* deps.emitItemNode(
      turn,
      toolCallId,
      "tool_call",
      status,
      startedAt,
      completed ? emittedAt : null,
      parentToolCallId,
    );
    const shared = {
      ...base,
      status,
      completedAt: completed ? emittedAt : null,
    } as const;
    if (toolName === "bash" || toolName === "powershell") {
      const exitCode =
        recordNumber(recordField(resultRecord, "structuredContent"), "exit_code") ??
        recordNumber(recordField(resultRecord, "details"), "exitCode");
      yield* deps.emit({
        type: "turn_item.updated",
        driver: PI_PROVIDER,
        turnItem: {
          ...shared,
          title: toolName,
          type: "command_execution",
          input: recordString(args, "command") ?? "",
          ...(outputText.length > 0 ? { output: outputText } : {}),
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      });
      return;
    }
    if (toolName === "edit" || toolName === "write") {
      const fileName = recordString(args, "path") ?? recordString(args, "file_path");
      if (fileName !== undefined) {
        const diffStr =
          recordString(recordField(resultRecord, "details"), "patch") ??
          (isError && outputText.trim().length > 0 ? outputText : undefined);
        const newStr = toolName === "write" ? recordString(args, "content") : undefined;
        yield* deps.emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "file_change",
            fileName,
            ...(diffStr === undefined ? {} : { diffStr }),
            ...(newStr === undefined ? {} : { newStr }),
          },
        });
        return;
      }
    }
    const output = piToolOutput(resultRecord, toolName);
    yield* deps.emit({
      type: "turn_item.updated",
      driver: PI_PROVIDER,
      turnItem: {
        ...shared,
        title: toolName,
        type: "dynamic_tool",
        ...mcpToolPresentation({ toolName }),
        toolName,
        input: args ?? {},
        ...(output === undefined ? {} : { output }),
      },
    });
    if (toolName === "subagent") {
      yield* emitSubagentTasks(turn, toolCallId, resultRecord, completed);
    }
  });

  const emitSubagentTasks = Effect.fnUntraced(function* (
    turn: ActivePiTurn,
    toolCallId: string,
    resultRecord: unknown,
    completed: boolean,
  ) {
    const results = recordField(recordField(resultRecord, "details"), "results");
    if (!Array.isArray(results)) return;
    const emittedAt = yield* DateTime.now;
    const parentNodeId = idAllocator.derive.nodeFromProviderItem({
      driver: PI_PROVIDER,
      nativeItemId: toolCallId,
    });
    for (const [index, result] of results.entries()) {
      const agent = recordString(result, "agent");
      const task = recordString(result, "task");
      if (agent === undefined || task === undefined) continue;
      const nativeTaskId = `${toolCallId}:subagent:${recordNumber(result, "step") ?? index}`;
      const subagentId = idAllocator.derive.nodeFromProviderItem({
        driver: PI_PROVIDER,
        nativeItemId: nativeTaskId,
      });
      const startedAt = turn.toolStartedAt.get(nativeTaskId) ?? emittedAt;
      turn.toolStartedAt.set(nativeTaskId, startedAt);
      const finished = completed || recordField(result, "finished") === true;
      const stopReason = recordString(result, "stopReason");
      const interrupted = finished && stopReason === "aborted";
      const failed =
        finished &&
        !interrupted &&
        ((recordNumber(result, "exitCode") ?? 0) !== 0 || stopReason === "error");
      const status = interrupted
        ? "interrupted"
        : failed
          ? "failed"
          : finished
            ? "completed"
            : "running";
      const outputText = piSubagentOutput(result);
      const progress =
        !finished && outputText.length > 0 ? { progress: outputText.slice(0, 200) } : {};
      const resultText = finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null;
      yield* deps.emit({
        type: "subagent.updated",
        driver: PI_PROVIDER,
        subagent: {
          id: subagentId,
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver: PI_PROVIDER,
          providerInstanceId: options.instanceId,
          providerThreadId: turn.turnInput.providerThread.id,
          childThreadId: null,
          nativeTaskRef: providerRef(nativeTaskId),
          prompt: task,
          title: agent,
          model: recordString(result, "model") ?? null,
          status,
          ...progress,
          result: resultText,
          startedAt,
          completedAt: finished ? emittedAt : null,
          updatedAt: emittedAt,
        },
      });
      yield* deps.emit({
        type: "turn_item.updated",
        driver: PI_PROVIDER,
        turnItem: {
          ...deps.baseItemFields(turn, nativeTaskId, startedAt, emittedAt),
          status,
          title: agent,
          completedAt: finished ? emittedAt : null,
          type: "subagent",
          subagentId,
          origin: "provider_native",
          driver: PI_PROVIDER,
          providerInstanceId: options.instanceId,
          childThreadId: null,
          prompt: task,
          ...progress,
          result: resultText,
        },
      });
    }
  });

  const emitExtensionError = Effect.fnUntraced(function* (event: PiRpcRecord) {
    const state = m.threadState;
    const turn = state?.activeTurn ?? null;
    if (turn === null) {
      outOfTurnExtensionErrors.push(event);
      return;
    }
    const emittedAt = yield* DateTime.now;
    const nativeItemId = `extension-error:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;
    const extensionName = piExtensionDisplayName(recordString(event, "extensionPath"));
    const extensionEvent = recordString(event, "event");
    const detail = recordString(event, "error")?.trim();
    const message = [
      `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
      detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n\n");
    const failure = makeProviderFailure({
      message,
      class: "provider_error",
      retryable: false,
    });
    yield* deps.emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
    yield* deps.emit({
      type: "turn_item.updated",
      driver: PI_PROVIDER,
      turnItem: {
        ...deps.baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
        status: "failed",
        title: extensionName,
        completedAt: emittedAt,
        type: "error",
        failure,
      },
    });
  });

  return { emitToolItem, emitSubagentTasks, emitExtensionError };
};

export type Tools = ReturnType<typeof makeTools>;
