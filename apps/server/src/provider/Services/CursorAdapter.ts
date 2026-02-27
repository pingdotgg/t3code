/**
 * CursorAdapter - Cursor CLI implementation of the generic provider adapter contract.
 *
 * This service will own Cursor CLI (`agent`) process / stream-json semantics and emit
 * canonical provider runtime events via the shared provider adapter contract.
 *
 * This file intentionally defines raw Cursor stream-json schemas up front so the future
 * layer implementation can decode/validate NDJSON lines in a single place.
 *
 * @module CursorAdapter
 */
import { Schema, ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export const CursorCliSessionId = Schema.String.check(Schema.isNonEmpty());
export type CursorCliSessionId = typeof CursorCliSessionId.Type;

export const CursorCliTextContentPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type CursorCliTextContentPart = typeof CursorCliTextContentPart.Type;

export const CursorCliContentPart = Schema.Union([
  CursorCliTextContentPart,
  Schema.Struct({
    type: Schema.String,
  }),
]);
export type CursorCliContentPart = typeof CursorCliContentPart.Type;

export const CursorCliUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(CursorCliContentPart),
});
export type CursorCliUserMessage = typeof CursorCliUserMessage.Type;

export const CursorCliAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(CursorCliContentPart),
});
export type CursorCliAssistantMessage = typeof CursorCliAssistantMessage.Type;

export const CursorCliToolCallResult = Schema.Struct({
  success: Schema.optional(Schema.Unknown),
  failure: Schema.optional(Schema.Unknown),
  rejected: Schema.optional(Schema.Unknown),
});
export type CursorCliToolCallResult = typeof CursorCliToolCallResult.Type;

export const CursorCliToolCallEntry = Schema.Struct({
  args: Schema.optional(Schema.Unknown),
  result: Schema.optional(CursorCliToolCallResult),
});
export type CursorCliToolCallEntry = typeof CursorCliToolCallEntry.Type;

export const CursorCliFunctionToolCall = Schema.Struct({
  name: Schema.String,
  arguments: Schema.String,
  result: Schema.optional(CursorCliToolCallResult),
});
export type CursorCliFunctionToolCall = typeof CursorCliFunctionToolCall.Type;

export const CursorCliToolCallPayload = Schema.Struct({
  readToolCall: Schema.optional(CursorCliToolCallEntry),
  writeToolCall: Schema.optional(CursorCliToolCallEntry),
  editToolCall: Schema.optional(CursorCliToolCallEntry),
  shellToolCall: Schema.optional(CursorCliToolCallEntry),
  grepToolCall: Schema.optional(CursorCliToolCallEntry),
  globToolCall: Schema.optional(CursorCliToolCallEntry),
  function: Schema.optional(CursorCliFunctionToolCall),
});
export type CursorCliToolCallPayload = typeof CursorCliToolCallPayload.Type;

export const CursorCliTokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
});
export type CursorCliTokenUsage = typeof CursorCliTokenUsage.Type;

const CursorCliTimestampMs = {
  timestamp_ms: Schema.optional(Schema.Number),
} as const;

export const CursorCliSystemInitEvent = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: CursorCliSessionId,
  apiKeySource: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.String),
  ...CursorCliTimestampMs,
});
export type CursorCliSystemInitEvent = typeof CursorCliSystemInitEvent.Type;

export const CursorCliUserEvent = Schema.Struct({
  type: Schema.Literal("user"),
  message: CursorCliUserMessage,
  session_id: CursorCliSessionId,
  ...CursorCliTimestampMs,
});
export type CursorCliUserEvent = typeof CursorCliUserEvent.Type;

export const CursorCliAssistantEvent = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: CursorCliAssistantMessage,
  session_id: CursorCliSessionId,
  ...CursorCliTimestampMs,
});
export type CursorCliAssistantEvent = typeof CursorCliAssistantEvent.Type;

export const CursorCliThinkingDeltaEvent = Schema.Struct({
  type: Schema.Literal("thinking"),
  subtype: Schema.Literal("delta"),
  text: Schema.String,
  session_id: CursorCliSessionId,
  ...CursorCliTimestampMs,
});
export type CursorCliThinkingDeltaEvent = typeof CursorCliThinkingDeltaEvent.Type;

export const CursorCliThinkingCompletedEvent = Schema.Struct({
  type: Schema.Literal("thinking"),
  subtype: Schema.Literal("completed"),
  session_id: CursorCliSessionId,
  ...CursorCliTimestampMs,
});
export type CursorCliThinkingCompletedEvent = typeof CursorCliThinkingCompletedEvent.Type;

export const CursorCliToolCallStartedEvent = Schema.Struct({
  type: Schema.Literal("tool_call"),
  subtype: Schema.Literal("started"),
  call_id: Schema.String,
  tool_call: CursorCliToolCallPayload,
  session_id: CursorCliSessionId,
  ...CursorCliTimestampMs,
});
export type CursorCliToolCallStartedEvent = typeof CursorCliToolCallStartedEvent.Type;

export const CursorCliToolCallCompletedEvent = Schema.Struct({
  type: Schema.Literal("tool_call"),
  subtype: Schema.Literal("completed"),
  call_id: Schema.String,
  tool_call: CursorCliToolCallPayload,
  session_id: CursorCliSessionId,
  ...CursorCliTimestampMs,
});
export type CursorCliToolCallCompletedEvent = typeof CursorCliToolCallCompletedEvent.Type;

export const CursorCliResultSuccessEvent = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.Literal("success"),
  duration_ms: Schema.Number,
  duration_api_ms: Schema.optional(Schema.Number),
  is_error: Schema.Boolean,
  result: Schema.String,
  session_id: CursorCliSessionId,
  request_id: Schema.optional(Schema.String),
  usage: Schema.optional(CursorCliTokenUsage),
  ...CursorCliTimestampMs,
});
export type CursorCliResultSuccessEvent = typeof CursorCliResultSuccessEvent.Type;

export const CursorCliConnectionEvent = Schema.Struct({
  type: Schema.Literal("connection"),
  subtype: Schema.Literals(["reconnecting", "reconnected"]),
  session_id: Schema.optional(CursorCliSessionId),
  ...CursorCliTimestampMs,
});
export type CursorCliConnectionEvent = typeof CursorCliConnectionEvent.Type;

export const CursorCliRetryEvent = Schema.Struct({
  type: Schema.Literal("retry"),
  subtype: Schema.Literals(["starting", "resuming"]),
  session_id: Schema.optional(CursorCliSessionId),
  ...CursorCliTimestampMs,
});
export type CursorCliRetryEvent = typeof CursorCliRetryEvent.Type;

export const CursorCliStreamEvent = Schema.Union([
  CursorCliSystemInitEvent,
  CursorCliUserEvent,
  CursorCliAssistantEvent,
  CursorCliThinkingDeltaEvent,
  CursorCliThinkingCompletedEvent,
  CursorCliToolCallStartedEvent,
  CursorCliToolCallCompletedEvent,
  CursorCliResultSuccessEvent,
  CursorCliConnectionEvent,
  CursorCliRetryEvent,
]);
export type CursorCliStreamEvent = typeof CursorCliStreamEvent.Type;

/**
 * CursorAdapterShape - Service API for the Cursor provider adapter.
 *
 * `provider` is intentionally narrowed to `"cursor"` here. Until contracts add
 * Cursor to `ProviderKind`, this shape is defined via `Omit<...,"provider">`.
 */
export interface CursorAdapterShape
  extends Omit<ProviderAdapterShape<ProviderAdapterError>, "provider"> {
  readonly provider: "cursor";
}

/**
 * CursorAdapter - Service tag for Cursor provider adapter operations.
 */
export class CursorAdapter extends ServiceMap.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Services/CursorAdapter",
) {}
