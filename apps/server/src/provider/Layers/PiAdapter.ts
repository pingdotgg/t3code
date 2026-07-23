import * as NodeCrypto from "node:crypto";

import {
  type ChatImageAttachment,
  EventId,
  type ModelSelection,
  type PiSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { parsePiModelSlug, makePiModelSlug } from "../Drivers/PiModels.ts";
import {
  type PiPromptImage,
  type PiSessionRuntimeError,
  type PiSessionRuntimeOptions,
  type PiSessionRuntimeShape,
} from "../Drivers/PiSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const UNSUPPORTED_OPERATION_MESSAGE =
  "This Pi operation is not available until conversation controls are installed.";

export type PiRuntimeFactory<R = never> = (
  options: PiSessionRuntimeOptions,
) => Effect.Effect<PiSessionRuntimeShape, PiSessionRuntimeError, R | Scope.Scope>;

export type PiImageAttachmentLoader = (
  attachment: ChatImageAttachment,
) => Effect.Effect<PiPromptImage, ProviderAdapterRequestError>;

export interface PiAdapterOptions<R = never> {
  readonly instanceId: ProviderInstanceId;
  readonly sessionDirectory: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Resolves persisted T3 image attachments into Pi's native prompt images. */
  readonly loadImageAttachment?: PiImageAttachmentLoader | undefined;
  readonly makeRuntime: PiRuntimeFactory<R>;
}

export function makePiImageAttachmentLoader(input: {
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}): PiImageAttachmentLoader {
  return (attachment) =>
    Effect.gen(function* () {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: "Failed to read Pi image attachment.",
              cause,
            }),
        ),
      );
      return {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      } satisfies PiPromptImage;
    });
}

interface PiAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: PiSessionRuntimeShape;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  readonly thinkingTasks: Map<number, { readonly taskId: RuntimeTaskId; text: string }>;
  readonly toolCalls: Map<
    string,
    { readonly toolCallId: string; readonly toolName: string; readonly contentIndex: number }
  >;
  readonly toolCallIdsByContentIndex: Map<number, string>;
  terminalOutcome:
    | { readonly state: "failed" | "interrupted"; readonly errorMessage?: string }
    | undefined;
  queueTaskId: RuntimeTaskId | undefined;
  compactionItemId: RuntimeItemId | undefined;
  readonly retryTaskIds: Map<number, RuntimeTaskId>;
  summarizationRetryTaskId: RuntimeTaskId | undefined;
  nextSyntheticItemId: number;
  nextSyntheticTaskId: number;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function piEventType(value: unknown): string | undefined {
  return isRecord(value) ? nonEmptyString(value.type) : undefined;
}

function piAssistantMessageRole(value: unknown): string | undefined {
  return isRecord(value) ? nonEmptyString(value.role) : undefined;
}

function piTextDelta(
  value: unknown,
): { readonly contentIndex?: number; readonly delta: string } | undefined {
  if (!isRecord(value) || value.type !== "text_delta" || typeof value.delta !== "string") {
    return undefined;
  }
  return {
    delta: value.delta,
    ...(typeof value.contentIndex === "number" && Number.isInteger(value.contentIndex)
      ? { contentIndex: value.contentIndex }
      : {}),
  };
}

function piThinkingEvent(
  value: unknown,
):
  | { readonly type: "start" | "end"; readonly contentIndex: number }
  | { readonly type: "delta"; readonly contentIndex: number; readonly delta: string }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const contentIndex =
    typeof value.contentIndex === "number" && Number.isInteger(value.contentIndex)
      ? value.contentIndex
      : 0;
  if (value.type === "thinking_start") {
    return { type: "start", contentIndex };
  }
  if (value.type === "thinking_end") {
    return { type: "end", contentIndex };
  }
  if (value.type === "thinking_delta" && typeof value.delta === "string") {
    return { type: "delta", contentIndex, delta: value.delta };
  }
  return undefined;
}

function piToolCallEvent(value: unknown):
  | {
      readonly type: "start";
      readonly contentIndex: number;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly type: "delta"; readonly contentIndex: number; readonly delta: string }
  | {
      readonly type: "end";
      readonly contentIndex: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | undefined {
  if (
    !isRecord(value) ||
    typeof value.contentIndex !== "number" ||
    !Number.isInteger(value.contentIndex)
  ) {
    return undefined;
  }
  if (value.type === "toolcall_start") {
    const toolCallId = nonEmptyString(value.id);
    const toolName = nonEmptyString(value.toolName);
    return toolCallId && toolName
      ? { type: "start", contentIndex: value.contentIndex, toolCallId, toolName }
      : undefined;
  }
  if (value.type === "toolcall_delta" && typeof value.delta === "string") {
    return { type: "delta", contentIndex: value.contentIndex, delta: value.delta };
  }
  if (value.type !== "toolcall_end" || !isRecord(value.toolCall)) {
    return undefined;
  }
  const toolCallId = nonEmptyString(value.toolCall.id);
  const toolName = nonEmptyString(value.toolCall.name);
  if (!toolCallId || !toolName || !Object.hasOwn(value.toolCall, "arguments")) {
    return undefined;
  }
  return {
    type: "end",
    contentIndex: value.contentIndex,
    toolCallId,
    toolName,
    args: value.toolCall.arguments,
  };
}

function piAssistantErrorMessage(assistantMessageEvent: Record<string, unknown>, message: unknown) {
  return (
    nonEmptyString(
      isRecord(assistantMessageEvent.error) ? assistantMessageEvent.error.errorMessage : undefined,
    ) ?? nonEmptyString(isRecord(message) ? message.errorMessage : undefined)
  );
}

type PiToolItemType =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view";

function piToolItemType(toolName: string): PiToolItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized.includes("subagent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function piToolResultText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return undefined;
  }
  const text = value.content
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

function piToolCommand(value: unknown): string | undefined {
  return isRecord(value) ? nonEmptyString(value.command) : undefined;
}

function piToolExecution(value: unknown):
  | {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const toolCallId = nonEmptyString(value.toolCallId);
  const toolName = nonEmptyString(value.toolName);
  if (!toolCallId || !toolName) {
    return undefined;
  }
  return {
    toolCallId,
    toolName,
    ...(Object.hasOwn(value, "args") ? { args: value.args } : {}),
    ...(Object.hasOwn(value, "result")
      ? { result: value.result }
      : Object.hasOwn(value, "partialResult")
        ? { result: value.partialResult }
        : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
  };
}

function runtimeProcessError(
  threadId: ThreadId,
  error: PiSessionRuntimeError,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: error.message,
    cause: error,
  });
}

function runtimeRequestError(
  method: string,
  error: PiSessionRuntimeError,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

/**
 * Build a Pi provider adapter bound to a single Pi Runtime Instance.
 *
 * Each adapter closure owns a separate session map and Pi Session Directory;
 * the T3 thread ID is always supplied to Pi as its native session ID.
 */
export function makePiAdapter<R>(
  piSettings: PiSettings,
  options: PiAdapterOptions<R>,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, R | Scope.Scope> {
  return Effect.gen(function* () {
    const runtimeFactory = options.makeRuntime;
    // Provider adapter methods cannot require services at call time. Capture
    // the runtime factory's infrastructure while the driver materializes this
    // instance, then re-provide it when a thread starts later.
    const runtimeContext = yield* Effect.context<R>();
    const sessions = new Map<ThreadId, PiAdapterSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const makeEventStamp = () =>
      Effect.map(DateTime.now, (now) => ({
        eventId: EventId.make(NodeCrypto.randomUUID()),
        createdAt: DateTime.formatIso(now),
      }));
    const publishRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);
    const rawPiEvent = (event: unknown, messageType: string) => ({
      source: "pi.rpc.event" as const,
      messageType,
      payload: event,
    });
    const newSyntheticItemId = (context: PiAdapterSessionContext, kind: string) => {
      context.nextSyntheticItemId += 1;
      return RuntimeItemId.make(
        `pi:${context.threadId}:${kind}:${String(context.nextSyntheticItemId)}`,
      );
    };
    const newAssistantItemId = (context: PiAdapterSessionContext) =>
      newSyntheticItemId(context, "assistant");
    const newSyntheticTaskId = (context: PiAdapterSessionContext, kind: string) => {
      context.nextSyntheticTaskId += 1;
      return RuntimeTaskId.make(
        `pi:${context.threadId}:${kind}:${String(context.nextSyntheticTaskId)}`,
      );
    };
    const newThinkingTask = (context: PiAdapterSessionContext, contentIndex: number) => {
      const task = {
        taskId: newSyntheticTaskId(context, "thinking"),
        text: "",
      };
      context.thinkingTasks.set(contentIndex, task);
      return task;
    };
    const ensureAssistantItem = (context: PiAdapterSessionContext, raw: unknown, type: string) =>
      Effect.gen(function* () {
        const turnId = context.activeTurnId;
        if (!turnId) {
          return undefined;
        }
        if (context.assistantItemId) {
          return context.assistantItemId;
        }
        const itemId = newAssistantItemId(context);
        context.assistantItemId = itemId;
        yield* publishRuntimeEvent({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
          },
          raw: rawPiEvent(raw, type),
        });
        return itemId;
      });
    const completeActiveTurn = (
      context: PiAdapterSessionContext,
      raw: unknown,
      messageType: string,
      state: "completed" | "failed" | "interrupted" = "completed",
      errorMessage?: string,
    ) =>
      Effect.gen(function* () {
        const turnId = context.activeTurnId;
        if (!turnId) {
          return;
        }
        const outcome = context.terminalOutcome;
        const effectiveState = outcome?.state ?? state;
        const effectiveErrorMessage = outcome?.errorMessage ?? errorMessage;
        context.activeTurnId = undefined;
        context.assistantItemId = undefined;
        context.toolCalls.clear();
        context.toolCallIdsByContentIndex.clear();
        context.terminalOutcome = undefined;
        const { activeTurnId: _activeTurnId, ...readySession } = context.session;
        context.session = {
          ...readySession,
          status: effectiveState === "failed" ? "error" : "ready",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          ...(effectiveState === "failed" && effectiveErrorMessage
            ? { lastError: effectiveErrorMessage }
            : {}),
        };
        yield* publishRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          payload: {
            state: effectiveState,
            ...(effectiveErrorMessage ? { errorMessage: effectiveErrorMessage } : {}),
          },
          raw: rawPiEvent(raw, messageType),
        });
      });
    const mapPiRuntimeEvent = (context: PiAdapterSessionContext, raw: unknown) =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }
        const type = piEventType(raw);
        if (!type || !isRecord(raw)) {
          return;
        }
        switch (type) {
          case "message_start": {
            if (piAssistantMessageRole(raw.message) === "assistant") {
              yield* ensureAssistantItem(context, raw, type);
            }
            return;
          }
          case "message_update": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const assistantMessageEvent = isRecord(raw.assistantMessageEvent)
              ? raw.assistantMessageEvent
              : undefined;
            if (assistantMessageEvent?.type === "error") {
              const wasAborted = assistantMessageEvent.reason === "aborted";
              const errorMessage =
                piAssistantErrorMessage(assistantMessageEvent, raw.message) ??
                (wasAborted
                  ? "Pi assistant response was aborted."
                  : "Pi assistant response failed.");
              context.terminalOutcome = {
                state: wasAborted ? "interrupted" : "failed",
                ...(wasAborted ? {} : { errorMessage }),
              };
              if (!wasAborted) {
                yield* publishRuntimeEvent({
                  type: "runtime.error",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  payload: { message: errorMessage },
                  raw: rawPiEvent(raw, type),
                });
              }
              return;
            }
            const textDelta = piTextDelta(raw.assistantMessageEvent);
            if (textDelta) {
              const itemId = yield* ensureAssistantItem(context, raw, type);
              if (!itemId) {
                return;
              }
              yield* publishRuntimeEvent({
                type: "content.delta",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                itemId,
                payload: {
                  streamKind: "assistant_text",
                  delta: textDelta.delta,
                  ...(textDelta.contentIndex !== undefined
                    ? { contentIndex: textDelta.contentIndex }
                    : {}),
                },
                raw: rawPiEvent(raw, type),
              });
              return;
            }

            const toolCall = piToolCallEvent(raw.assistantMessageEvent);
            if (toolCall) {
              if (toolCall.type === "start") {
                context.toolCalls.set(toolCall.toolCallId, toolCall);
                context.toolCallIdsByContentIndex.set(toolCall.contentIndex, toolCall.toolCallId);
                yield* publishRuntimeEvent({
                  type: "item.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(toolCall.toolCallId),
                  payload: {
                    itemType: piToolItemType(toolCall.toolName),
                    status: "inProgress",
                    title: toolCall.toolName,
                    data: {
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      contentIndex: toolCall.contentIndex,
                    },
                  },
                  raw: rawPiEvent(raw, type),
                });
                return;
              }
              if (toolCall.type === "delta") {
                const toolCallId = context.toolCallIdsByContentIndex.get(toolCall.contentIndex);
                const startedToolCall = toolCallId ? context.toolCalls.get(toolCallId) : undefined;
                if (!startedToolCall) {
                  return;
                }
                yield* publishRuntimeEvent({
                  type: "item.updated",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(startedToolCall.toolCallId),
                  payload: {
                    itemType: piToolItemType(startedToolCall.toolName),
                    status: "inProgress",
                    title: startedToolCall.toolName,
                    data: {
                      toolCallId: startedToolCall.toolCallId,
                      toolName: startedToolCall.toolName,
                      contentIndex: startedToolCall.contentIndex,
                      argumentDelta: toolCall.delta,
                    },
                  },
                  raw: rawPiEvent(raw, type),
                });
                return;
              }
              const existingToolCall = context.toolCalls.get(toolCall.toolCallId);
              context.toolCalls.set(toolCall.toolCallId, toolCall);
              context.toolCallIdsByContentIndex.set(toolCall.contentIndex, toolCall.toolCallId);
              const command = piToolCommand(toolCall.args);
              const payload = {
                itemType: piToolItemType(toolCall.toolName),
                status: "inProgress" as const,
                title: toolCall.toolName,
                ...(command ? { detail: command } : {}),
                data: {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  contentIndex: toolCall.contentIndex,
                  args: toolCall.args,
                  ...(command ? { command } : {}),
                },
              };
              if (existingToolCall) {
                yield* publishRuntimeEvent({
                  type: "item.updated",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(toolCall.toolCallId),
                  payload,
                  raw: rawPiEvent(raw, type),
                });
              } else {
                yield* publishRuntimeEvent({
                  type: "item.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  itemId: RuntimeItemId.make(toolCall.toolCallId),
                  payload,
                  raw: rawPiEvent(raw, type),
                });
              }
              return;
            }

            const thinking = piThinkingEvent(raw.assistantMessageEvent);
            if (!thinking) {
              return;
            }
            let task = context.thinkingTasks.get(thinking.contentIndex);
            if (!task) {
              task = newThinkingTask(context, thinking.contentIndex);
              yield* publishRuntimeEvent({
                type: "task.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: {
                  taskId: task.taskId,
                  description: "Thinking",
                  taskType: "thinking",
                },
                raw: rawPiEvent(raw, type),
              });
            }
            if (thinking.type === "start") {
              return;
            }
            if (thinking.type === "delta") {
              task.text += thinking.delta;
              const itemId = yield* ensureAssistantItem(context, raw, type);
              if (itemId) {
                yield* publishRuntimeEvent({
                  type: "content.delta",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: context.threadId,
                  turnId,
                  itemId,
                  payload: {
                    streamKind: "reasoning_text",
                    delta: thinking.delta,
                    contentIndex: thinking.contentIndex,
                  },
                  raw: rawPiEvent(raw, type),
                });
              }
              yield* publishRuntimeEvent({
                type: "task.progress",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: {
                  taskId: task.taskId,
                  description: "Thinking",
                  ...(task.text ? { summary: task.text } : {}),
                },
                raw: rawPiEvent(raw, type),
              });
              return;
            }
            context.thinkingTasks.delete(thinking.contentIndex);
            yield* publishRuntimeEvent({
              type: "task.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId: task.taskId,
                status: "completed",
                ...(task.text ? { summary: task.text } : {}),
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "message_end": {
            if (piAssistantMessageRole(raw.message) !== "assistant") {
              return;
            }
            const turnId = context.activeTurnId;
            const itemId = context.assistantItemId;
            if (!turnId || !itemId) {
              return;
            }
            context.assistantItemId = undefined;
            yield* publishRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: {
                itemType: "assistant_message",
                status: "completed",
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "tool_execution_start": {
            const turnId = context.activeTurnId;
            const execution = piToolExecution(raw);
            if (!turnId || !execution) {
              return;
            }
            const constructedToolCall = context.toolCalls.get(execution.toolCallId);
            if (!constructedToolCall) {
              context.toolCalls.set(execution.toolCallId, {
                toolCallId: execution.toolCallId,
                toolName: execution.toolName,
                contentIndex: -1,
              });
            }
            const command = piToolCommand(execution.args);
            const payload = {
              itemType: piToolItemType(execution.toolName),
              status: "inProgress" as const,
              title: execution.toolName,
              ...(command ? { detail: command } : {}),
              data: {
                toolCallId: execution.toolCallId,
                toolName: execution.toolName,
                ...(execution.args !== undefined ? { args: execution.args } : {}),
                ...(command ? { command } : {}),
              },
            };
            if (constructedToolCall) {
              yield* publishRuntimeEvent({
                type: "item.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                itemId: RuntimeItemId.make(execution.toolCallId),
                payload,
                raw: rawPiEvent(raw, type),
              });
            } else {
              yield* publishRuntimeEvent({
                type: "item.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                itemId: RuntimeItemId.make(execution.toolCallId),
                payload,
                raw: rawPiEvent(raw, type),
              });
            }
            return;
          }
          case "tool_execution_update": {
            const turnId = context.activeTurnId;
            const execution = piToolExecution(raw);
            if (!turnId || !execution) {
              return;
            }
            const command = piToolCommand(execution.args);
            const detail = piToolResultText(execution.result);
            yield* publishRuntimeEvent({
              type: "item.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              itemId: RuntimeItemId.make(execution.toolCallId),
              payload: {
                itemType: piToolItemType(execution.toolName),
                status: "inProgress",
                title: execution.toolName,
                ...(detail ? { detail } : {}),
                data: {
                  toolCallId: execution.toolCallId,
                  toolName: execution.toolName,
                  ...(execution.args !== undefined ? { args: execution.args } : {}),
                  ...(command ? { command } : {}),
                  ...(execution.result !== undefined ? { result: execution.result } : {}),
                },
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "tool_execution_end": {
            const turnId = context.activeTurnId;
            const execution = piToolExecution(raw);
            if (!turnId || !execution) {
              return;
            }
            const detail = piToolResultText(execution.result);
            const command = piToolCommand(execution.args);
            const failed = execution.isError === true;
            yield* publishRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              itemId: RuntimeItemId.make(execution.toolCallId),
              payload: {
                itemType: piToolItemType(execution.toolName),
                status: failed ? "failed" : "completed",
                title: execution.toolName,
                ...(detail ? { detail } : {}),
                data: {
                  toolCallId: execution.toolCallId,
                  toolName: execution.toolName,
                  ...(command ? { command } : {}),
                  ...(execution.result !== undefined ? { result: execution.result } : {}),
                },
              },
              raw: rawPiEvent(raw, type),
            });
            if (failed) {
              yield* publishRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: {
                  message: `Pi tool '${execution.toolName}' failed.`,
                  ...(detail ? { detail } : {}),
                },
                raw: rawPiEvent(raw, type),
              });
            }
            const constructedToolCall = context.toolCalls.get(execution.toolCallId);
            context.toolCalls.delete(execution.toolCallId);
            if (
              constructedToolCall &&
              context.toolCallIdsByContentIndex.get(constructedToolCall.contentIndex) ===
                execution.toolCallId
            ) {
              context.toolCallIdsByContentIndex.delete(constructedToolCall.contentIndex);
            }
            return;
          }
          case "queue_update": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const steeringCount = Array.isArray(raw.steering) ? raw.steering.length : 0;
            const followUpCount = Array.isArray(raw.followUp) ? raw.followUp.length : 0;
            if (steeringCount + followUpCount === 0) {
              const taskId = context.queueTaskId;
              if (!taskId) {
                return;
              }
              context.queueTaskId = undefined;
              yield* publishRuntimeEvent({
                type: "task.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: {
                  taskId,
                  status: "completed",
                  summary: "Queued work processed",
                },
                raw: rawPiEvent(raw, type),
              });
              return;
            }
            const taskId = context.queueTaskId ?? newSyntheticTaskId(context, "queue");
            if (!context.queueTaskId) {
              context.queueTaskId = taskId;
              yield* publishRuntimeEvent({
                type: "task.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: {
                  taskId,
                  description: "Queued work",
                  taskType: "queued_work",
                },
                raw: rawPiEvent(raw, type),
              });
            }
            const queueParts = [
              ...(steeringCount > 0
                ? [`${String(steeringCount)} steering message${steeringCount === 1 ? "" : "s"}`]
                : []),
              ...(followUpCount > 0
                ? [
                    `${String(followUpCount)} follow-up${
                      followUpCount === 1 ? " message" : " messages"
                    }`,
                  ]
                : []),
            ];
            yield* publishRuntimeEvent({
              type: "task.progress",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                description: "Queued work",
                summary: `${queueParts.join(" and ")} queued`,
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "compaction_start": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const itemId = context.compactionItemId ?? newSyntheticItemId(context, "compaction");
            context.compactionItemId = itemId;
            const reason = nonEmptyString(raw.reason);
            yield* publishRuntimeEvent({
              type: "item.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: {
                itemType: "context_compaction",
                status: "inProgress",
                title: "Compacting conversation",
                ...(reason ? { detail: `Reason: ${reason}` } : {}),
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "compaction_end": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const itemId = context.compactionItemId ?? newSyntheticItemId(context, "compaction");
            context.compactionItemId = undefined;
            const result = isRecord(raw.result) ? raw.result : undefined;
            const detail =
              nonEmptyString(result?.summary) ??
              nonEmptyString(raw.errorMessage) ??
              (raw.aborted === true ? "Compaction was aborted." : undefined);
            const failed = raw.aborted !== true && nonEmptyString(raw.errorMessage) !== undefined;
            yield* publishRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: {
                itemType: "context_compaction",
                status: failed ? "failed" : "completed",
                title: failed ? "Context compaction failed" : "Context compacted",
                ...(detail ? { detail } : {}),
                ...(result ? { data: result } : {}),
              },
              raw: rawPiEvent(raw, type),
            });
            if (failed && detail) {
              context.terminalOutcome = { state: "failed", errorMessage: detail };
              yield* publishRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: { message: detail },
                raw: rawPiEvent(raw, type),
              });
            }
            return;
          }
          case "auto_retry_start": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const attempt = typeof raw.attempt === "number" ? raw.attempt : 0;
            const taskId = newSyntheticTaskId(context, "retry");
            context.retryTaskIds.set(attempt, taskId);
            const errorMessage = nonEmptyString(raw.errorMessage);
            const maxAttempts = typeof raw.maxAttempts === "number" ? raw.maxAttempts : undefined;
            const delayMs = typeof raw.delayMs === "number" ? raw.delayMs : undefined;
            yield* publishRuntimeEvent({
              type: "task.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                description: "Retrying Pi request",
                taskType: "retry",
              },
              raw: rawPiEvent(raw, type),
            });
            yield* publishRuntimeEvent({
              type: "task.progress",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                description: "Retrying Pi request",
                summary: `Attempt ${String(attempt)}${
                  maxAttempts !== undefined ? ` of ${String(maxAttempts)}` : ""
                }${delayMs !== undefined ? ` after ${String(delayMs)} ms` : ""}${
                  errorMessage ? `: ${errorMessage}` : ""
                }`,
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "auto_retry_end": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const attempt = typeof raw.attempt === "number" ? raw.attempt : 0;
            const taskId =
              context.retryTaskIds.get(attempt) ?? newSyntheticTaskId(context, "retry");
            context.retryTaskIds.delete(attempt);
            const success = raw.success === true;
            const errorMessage = nonEmptyString(raw.finalError);
            yield* publishRuntimeEvent({
              type: "task.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                status: success ? "completed" : "failed",
                ...(success ? { summary: "Pi request retry succeeded" } : {}),
                ...(!success && errorMessage ? { summary: errorMessage } : {}),
              },
              raw: rawPiEvent(raw, type),
            });
            if (!success && errorMessage) {
              context.terminalOutcome = { state: "failed", errorMessage };
              yield* publishRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: { message: errorMessage },
                raw: rawPiEvent(raw, type),
              });
            }
            return;
          }
          case "summarization_retry_scheduled": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const taskId = newSyntheticTaskId(context, "summarization-retry");
            context.summarizationRetryTaskId = taskId;
            const attempt = typeof raw.attempt === "number" ? raw.attempt : 0;
            const maxAttempts = typeof raw.maxAttempts === "number" ? raw.maxAttempts : undefined;
            yield* publishRuntimeEvent({
              type: "task.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                description: "Retrying Pi summarization",
                taskType: "retry",
              },
              raw: rawPiEvent(raw, type),
            });
            yield* publishRuntimeEvent({
              type: "task.progress",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                description: "Retrying Pi summarization",
                summary: `Attempt ${String(attempt)}${
                  maxAttempts !== undefined ? ` of ${String(maxAttempts)}` : ""
                }`,
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "summarization_retry_attempt_start": {
            const turnId = context.activeTurnId;
            const taskId = context.summarizationRetryTaskId;
            if (!turnId || !taskId) {
              return;
            }
            const source = nonEmptyString(raw.source) ?? "summarization";
            yield* publishRuntimeEvent({
              type: "task.progress",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                description: "Retrying Pi summarization",
                summary: `Retrying ${source}`,
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "summarization_retry_finished": {
            const turnId = context.activeTurnId;
            const taskId = context.summarizationRetryTaskId;
            if (!turnId || !taskId) {
              return;
            }
            context.summarizationRetryTaskId = undefined;
            yield* publishRuntimeEvent({
              type: "task.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                taskId,
                status: "completed",
                summary: "Pi summarization retry finished",
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "agent_end": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            if (raw.willRetry === true) {
              yield* publishRuntimeEvent({
                type: "runtime.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: { message: "Pi will retry a transient provider error." },
                raw: rawPiEvent(raw, type),
              });
              return;
            }
            const messages = Array.isArray(raw.messages) ? raw.messages : [];
            const lastAssistantMessage = messages
              .toReversed()
              .find((message) => isRecord(message) && message.role === "assistant");
            if (!isRecord(lastAssistantMessage)) {
              return;
            }
            const stopReason = nonEmptyString(lastAssistantMessage.stopReason);
            if (stopReason !== "error" && stopReason !== "aborted") {
              return;
            }
            const wasAborted = stopReason === "aborted";
            const errorMessage =
              nonEmptyString(lastAssistantMessage.errorMessage) ??
              (wasAborted ? "Pi assistant response was aborted." : "Pi assistant response failed.");
            context.terminalOutcome = {
              state: wasAborted ? "interrupted" : "failed",
              ...(wasAborted ? {} : { errorMessage }),
            };
            if (!wasAborted) {
              yield* publishRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: context.threadId,
                turnId,
                payload: { message: errorMessage },
                raw: rawPiEvent(raw, type),
              });
            }
            return;
          }
          case "extension_error": {
            const turnId = context.activeTurnId;
            if (!turnId) {
              return;
            }
            const errorMessage = nonEmptyString(raw.error) ?? "Pi extension failed.";
            yield* publishRuntimeEvent({
              type: "runtime.error",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              payload: {
                message: errorMessage,
                detail: {
                  ...(nonEmptyString(raw.extensionPath)
                    ? { extensionPath: nonEmptyString(raw.extensionPath) }
                    : {}),
                  ...(nonEmptyString(raw.event) ? { event: nonEmptyString(raw.event) } : {}),
                },
              },
              raw: rawPiEvent(raw, type),
            });
            return;
          }
          case "agent_settled": {
            yield* completeActiveTurn(context, raw, type);
            return;
          }
          default:
            return;
        }
      });

    const stopSessionInternal = (context: PiAdapterSessionContext): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (context.stopped) {
          return Effect.void;
        }
        context.stopped = true;
        return context.runtime.close.pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(context.scope, Exit.void).pipe(Effect.ignore)),
          Effect.andThen(
            Effect.sync(() => {
              if (sessions.get(context.threadId) === context) {
                sessions.delete(context.threadId);
              }
            }),
          ),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiAdapterSessionContext, ProviderAdapterSessionNotFoundError> => {
      const session = sessions.get(threadId);
      if (session && !session.stopped) {
        return Effect.succeed(session);
      }
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const applyModelSelection = (input: {
      readonly runtime: PiSessionRuntimeShape;
      readonly modelSelection: ModelSelection | undefined;
      readonly initialModel: string | undefined;
      readonly operation: "startSession" | "sendTurn";
    }) =>
      Effect.gen(function* () {
        const selection = input.modelSelection;
        if (!selection || selection.instanceId !== options.instanceId) {
          return input.initialModel;
        }

        const piModel = parsePiModelSlug(selection.model);
        if (!piModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Model '${selection.model}' is not a valid Pi provider/model selection.`,
          });
        }

        yield* input.runtime
          .setModel(piModel)
          .pipe(Effect.mapError((error) => runtimeRequestError("set_model", error)));

        const requestedThinkingLevel = getModelSelectionStringOptionValue(
          selection,
          "reasoningEffort",
        );
        if (!requestedThinkingLevel) {
          return makePiModelSlug(piModel);
        }

        const levels = yield* input.runtime
          .getAvailableThinkingLevels()
          .pipe(
            Effect.mapError((error) => runtimeRequestError("get_available_thinking_levels", error)),
          );
        if (!levels.includes(requestedThinkingLevel)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Pi model '${selection.model}' does not support thinking level '${requestedThinkingLevel}'.`,
          });
        }

        yield* input.runtime
          .setThinkingLevel(requestedThinkingLevel)
          .pipe(Effect.mapError((error) => runtimeRequestError("set_thinking_level", error)));
        return makePiModelSlug(piModel);
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (
            input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected Pi runtime instance '${options.instanceId}' but received '${input.providerInstanceId}'.`,
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
          );

          const runtime = yield* runtimeFactory({
            binaryPath: piSettings.binaryPath,
            configDirectory: piSettings.configDirectory,
            launchArgs: piSettings.launchArgs,
            cwd: input.cwd ?? process.cwd(),
            ...(options.environment ? { environment: options.environment } : {}),
            sessionDirectory: options.sessionDirectory,
            sessionId: input.threadId,
          }).pipe(
            Effect.provideContext(runtimeContext),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((error) => runtimeProcessError(input.threadId, error)),
          );
          const state = yield* runtime
            .start()
            .pipe(Effect.mapError((error) => runtimeProcessError(input.threadId, error)));
          // Pi allocates the persistent native session identity/path at
          // startup but flushes its session file lazily while persisting the
          // first accepted prompt's turn. Prompt delivery owns that flow.
          const initialModel = state.model
            ? makePiModelSlug({ provider: state.model.provider, modelId: state.model.id })
            : undefined;
          const model = yield* applyModelSelection({
            runtime,
            modelSelection: input.modelSelection,
            initialModel,
            operation: "startSession",
          });
          const now = DateTime.formatIso(yield* DateTime.now);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(model ? { model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: 1,
              sessionId: input.threadId,
            },
            createdAt: now,
            updatedAt: now,
          };
          const context: PiAdapterSessionContext = {
            threadId: input.threadId,
            scope: sessionScope,
            runtime,
            session,
            activeTurnId: undefined,
            assistantItemId: undefined,
            thinkingTasks: new Map(),
            toolCalls: new Map(),
            toolCallIdsByContentIndex: new Map(),
            terminalOutcome: undefined,
            queueTaskId: undefined,
            compactionItemId: undefined,
            retryTaskIds: new Map(),
            summarizationRetryTaskId: undefined,
            nextSyntheticItemId: 0,
            nextSyntheticTaskId: 0,
            stopped: false,
          };
          sessions.set(input.threadId, context);
          yield* Stream.runForEach(runtime.events, (event) =>
            mapPiRuntimeEvent(context, event),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to map Pi RPC runtime event.", {
                cause,
                threadId: context.threadId,
              }),
            ),
            Effect.forkIn(sessionScope),
          );
          transferred = true;
          return session;
        }),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      requireSession(input.threadId).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            const model = yield* applyModelSelection({
              runtime: context.runtime,
              modelSelection: input.modelSelection,
              initialModel: context.session.model,
              operation: "sendTurn",
            });
            const attachments = input.attachments ?? [];
            const loadImageAttachment = options.loadImageAttachment;
            if (attachments.length > 0 && !loadImageAttachment) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: "Pi image attachment loading is not configured.",
              });
            }
            const images = loadImageAttachment
              ? yield* Effect.forEach(attachments, loadImageAttachment)
              : [];
            const activeTurnId = context.activeTurnId;
            const turnId = activeTurnId ?? TurnId.make(NodeCrypto.randomUUID());
            const updatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
            if (!activeTurnId) {
              context.toolCalls.clear();
              context.toolCallIdsByContentIndex.clear();
            }
            context.activeTurnId = turnId;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt,
            };
            if (!activeTurnId) {
              yield* publishRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: model ? { model } : {},
              });
            }
            yield* context.runtime
              .prompt({
                message: input.input ?? "",
                ...(images.length > 0 ? { images } : {}),
                ...(activeTurnId ? { streamingBehavior: "followUp" as const } : {}),
              })
              .pipe(
                Effect.mapError((error) => runtimeRequestError("prompt", error)),
                Effect.tapError((error) =>
                  activeTurnId
                    ? Effect.void
                    : completeActiveTurn(
                        context,
                        { type: "prompt", error: error.message },
                        "prompt",
                        "failed",
                        error.message,
                      ),
                ),
              );
            return {
              threadId: input.threadId,
              turnId,
              ...(context.session.resumeCursor
                ? { resumeCursor: context.session.resumeCursor }
                : {}),
            };
          }),
        ),
      );

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      requestedTurnId,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            const activeTurnId = context.activeTurnId;
            if (requestedTurnId !== undefined && activeTurnId !== requestedTurnId) {
              return;
            }
            yield* context.runtime
              .abort()
              .pipe(Effect.mapError((error) => runtimeRequestError("abort", error)));
            yield* completeActiveTurn(context, { type: "abort" }, "abort", "interrupted");
          }),
        ),
      );

    const unavailableOperation = (method: string, threadId: ThreadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: UNSUPPORTED_OPERATION_MESSAGE,
            }),
          ),
        ),
      );

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      // Pi natively applies model/thinking changes to a live RPC session.
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId) => unavailableOperation("extension_ui_response", threadId),
      respondToUserInput: (threadId) => unavailableOperation("extension_ui_response", threadId),
      stopSession: (threadId) =>
        requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal), Effect.asVoid),
      listSessions: () =>
        Effect.sync(() =>
          Array.from(sessions.values(), (context) => context.session).filter(
            (session) => !sessions.get(session.threadId)?.stopped,
          ),
        ),
      hasSession: (threadId) => Effect.succeed(Boolean(sessions.get(threadId)?.stopped === false)),
      readThread: (threadId) => unavailableOperation("get_messages", threadId),
      rollbackThread: (threadId) => unavailableOperation("rollback", threadId),
      stopAll: () =>
        Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
    return adapter;
  });
}
