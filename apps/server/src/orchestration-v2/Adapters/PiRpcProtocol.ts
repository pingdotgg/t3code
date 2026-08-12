import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { PiRpcProtocolError, type PiRpcRecord } from "./PiRpcTransport.ts";

export const PiThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type PiThinkingLevel = typeof PiThinkingLevel.Type;

const PiUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  reasoning: Schema.optional(Schema.Number),
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
});
export type PiUsage = typeof PiUsage.Type;

const PiAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.String,
  model: Schema.String,
  usage: PiUsage,
  stopReason: Schema.Literals(["pending", "stop", "length", "toolUse", "error", "aborted"]),
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
});

const PiMessage = Schema.Record(Schema.String, Schema.Unknown);

const PiAssistantMessageEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text_delta"),
    contentIndex: Schema.Number,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_delta"),
    contentIndex: Schema.Number,
    delta: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("text_start"), contentIndex: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("text_end"),
    contentIndex: Schema.Number,
    content: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("thinking_start"), contentIndex: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("thinking_end"),
    contentIndex: Schema.Number,
    content: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("toolcall_start"), contentIndex: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("toolcall_delta"),
    contentIndex: Schema.Number,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    contentIndex: Schema.Number,
    toolCall: Schema.Struct({
      type: Schema.Literal("toolCall"),
      id: Schema.String,
      name: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.Unknown),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("done") }),
  Schema.Struct({ type: Schema.Literal("error") }),
]);

const PiKnownEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent_start") }),
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    messages: Schema.Array(PiMessage),
    willRetry: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("agent_settled") }),
  Schema.Struct({ type: Schema.Literal("turn_start") }),
  Schema.Struct({ type: Schema.Literal("turn_end"), message: PiMessage }),
  Schema.Struct({ type: Schema.Literal("message_start"), message: PiMessage }),
  Schema.Struct({
    type: Schema.Literal("message_update"),
    message: PiMessage,
    assistantMessageEvent: PiAssistantMessageEvent,
  }),
  Schema.Struct({ type: Schema.Literal("message_end"), message: PiMessage }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    partialResult: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("queue_update"),
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_start"),
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_end"),
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
    errorMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("thinking_level_changed"), level: PiThinkingLevel }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_start"),
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    attempt: Schema.Number,
    finalError: Schema.optional(Schema.String),
  }),
]);
export type PiKnownEvent = typeof PiKnownEvent.Type;

const knownEventTypes = new Set<string>([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
]);

const decodeKnownEvent = Schema.decodeUnknownEffect(PiKnownEvent);

export type PiDecodedEvent =
  | { readonly _tag: "known"; readonly event: PiKnownEvent }
  | { readonly _tag: "unknown"; readonly event: PiRpcRecord };

/** Unknown event types remain forward compatible; malformed known events fail closed. */
export function decodePiEvent(
  record: PiRpcRecord,
): Effect.Effect<PiDecodedEvent, PiRpcProtocolError> {
  const type = record["type"];
  if (!Predicate.isString(type) || !knownEventTypes.has(type)) {
    return Effect.succeed({ _tag: "unknown", event: record });
  }
  return decodeKnownEvent(record).pipe(
    Effect.map((event) => ({ _tag: "known", event }) as const),
    Effect.mapError(
      (cause) =>
        new PiRpcProtocolError({
          detail: `invalid ${type} event`,
          payload: record,
          cause,
        }),
    ),
  );
}

export type PiTerminalStatus = "completed" | "interrupted" | "failed";

export type PiProjectedEvent =
  | { readonly type: "run.started" }
  | { readonly type: "run.settled" }
  | { readonly type: "turn.started" }
  | { readonly type: "assistant.delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "reasoning.delta"; readonly contentIndex: number; readonly delta: string }
  | {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool.updated";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly partialResult: unknown;
    }
  | {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
    }
  | {
      readonly type: "message.completed";
      readonly provider: string;
      readonly model: string;
      readonly stopReason: string;
      readonly errorMessage?: string;
      readonly usage: PiUsage;
    }
  | {
      readonly type: "run.retrying";
      readonly attempt?: number;
      readonly maxAttempts?: number;
      readonly delayMs?: number;
      readonly errorMessage?: string;
    }
  | {
      readonly type: "run.terminal";
      readonly status: PiTerminalStatus;
      readonly errorMessage?: string;
    }
  | {
      readonly type: "queue.updated";
      readonly steering: ReadonlyArray<string>;
      readonly followUp: ReadonlyArray<string>;
    }
  | {
      readonly type: "compaction.updated";
      readonly status: "running" | "completed" | "interrupted" | "failed";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly errorMessage?: string;
    }
  | { readonly type: "thinking.updated"; readonly level: PiThinkingLevel };

const decodeAssistantMessage = Schema.decodeUnknownOption(PiAssistantMessage);

function lastAssistantMessage(messages: ReadonlyArray<PiRpcRecord>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const decoded = decodeAssistantMessage(messages[index]);
    if (Option.isSome(decoded)) return decoded.value;
  }
  return undefined;
}

export function projectPiEvent(event: PiKnownEvent): ReadonlyArray<PiProjectedEvent> {
  switch (event.type) {
    case "agent_start":
      return [{ type: "run.started" }];
    case "agent_settled":
      return [{ type: "run.settled" }];
    case "turn_start":
      return [{ type: "turn.started" }];
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return [
          { type: "assistant.delta", contentIndex: update.contentIndex, delta: update.delta },
        ];
      }
      if (update.type === "thinking_delta") {
        return [
          { type: "reasoning.delta", contentIndex: update.contentIndex, delta: update.delta },
        ];
      }
      return [];
    }
    case "message_end": {
      const decoded = decodeAssistantMessage(event.message);
      if (Option.isNone(decoded)) return [];
      const message = decoded.value;
      return [
        {
          type: "message.completed",
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
          usage: message.usage,
        },
      ];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool.started",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
      ];
    case "tool_execution_update":
      return [
        {
          type: "tool.updated",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          partialResult: event.partialResult,
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool.completed",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
      ];
    case "agent_end": {
      if (event.willRetry) return [{ type: "run.retrying" }];
      const message = lastAssistantMessage(event.messages);
      if (message?.stopReason === "aborted") {
        return [
          {
            type: "run.terminal",
            status: "interrupted",
            ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
          },
        ];
      }
      if (message?.stopReason === "error") {
        return [
          {
            type: "run.terminal",
            status: "failed",
            ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
          },
        ];
      }
      return [{ type: "run.terminal", status: "completed" }];
    }
    case "auto_retry_start":
      return [
        {
          type: "run.retrying",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      ];
    case "queue_update":
      return [{ type: "queue.updated", steering: event.steering, followUp: event.followUp }];
    case "compaction_start":
      return [{ type: "compaction.updated", status: "running", reason: event.reason }];
    case "compaction_end":
      return [
        {
          type: "compaction.updated",
          status: event.aborted
            ? "interrupted"
            : event.errorMessage === undefined
              ? "completed"
              : "failed",
          reason: event.reason,
          ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
        },
      ];
    case "thinking_level_changed":
      return [{ type: "thinking.updated", level: event.level }];
    case "auto_retry_end":
    case "message_start":
    case "turn_end":
      return [];
  }
}

export type PiRuntimePrompt =
  | {
      readonly type: "approval";
      readonly requestId: string;
      readonly title: string;
      readonly message: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly type: "user-input";
      readonly requestId: string;
      readonly method: "select" | "input" | "editor";
      readonly title: string;
      readonly options?: ReadonlyArray<string>;
      readonly placeholder?: string;
      readonly prefill?: string;
      readonly timeoutMs?: number;
    };

export function projectPiExtensionUiRequest(request: PiRpcRecord): PiRuntimePrompt | undefined {
  const id = request["id"];
  const method = request["method"];
  const title = request["title"];
  if (!Predicate.isString(id) || !Predicate.isString(method) || !Predicate.isString(title)) {
    return undefined;
  }
  const timeout = request["timeout"];
  const timeoutMs = Predicate.isNumber(timeout) ? timeout : undefined;
  if (method === "confirm") {
    const message = request["message"];
    if (!Predicate.isString(message)) return undefined;
    return {
      type: "approval",
      requestId: id,
      title,
      message,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (method === "select") {
    const options = request["options"];
    if (!Array.isArray(options) || !options.every(Predicate.isString)) return undefined;
    return {
      type: "user-input",
      requestId: id,
      method,
      title,
      options,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (method === "input") {
    const placeholder = request["placeholder"];
    return {
      type: "user-input",
      requestId: id,
      method,
      title,
      ...(Predicate.isString(placeholder) ? { placeholder } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }
  if (method === "editor") {
    const prefill = request["prefill"];
    return {
      type: "user-input",
      requestId: id,
      method,
      title,
      ...(Predicate.isString(prefill) ? { prefill } : {}),
    };
  }
  return undefined;
}
