/**
 * CursorAdapter - Cursor ACP implementation of the generic provider adapter contract.
 *
 * Defines ACP JSON-RPC schemas used by the Cursor adapter layer.
 *
 * @module CursorAdapter
 */
import { Schema, ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export const CursorAcpJsonRpcId = Schema.Union([Schema.String, Schema.Int]);
export type CursorAcpJsonRpcId = typeof CursorAcpJsonRpcId.Type;

export const CursorAcpSessionUpdate = Schema.Union([
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
      }),
    ),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("agent_thought_chunk"),
    content: Schema.optional(Schema.Unknown),
    text: Schema.optional(Schema.String),
    delta: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("agent_message_chunk"),
    content: Schema.optional(Schema.Unknown),
    text: Schema.optional(Schema.String),
    delta: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call"),
    toolCallId: Schema.String,
    title: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    rawInput: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call_update"),
    toolCallId: Schema.String,
    status: Schema.String,
    rawOutput: Schema.optional(Schema.Unknown),
  }),
]);
export type CursorAcpSessionUpdate = typeof CursorAcpSessionUpdate.Type;

export const CursorAcpSessionUpdateNotification = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  method: Schema.Literal("session/update"),
  params: Schema.Struct({
    sessionId: Schema.String,
    update: CursorAcpSessionUpdate,
  }),
});
export type CursorAcpSessionUpdateNotification = typeof CursorAcpSessionUpdateNotification.Type;

export const CursorAcpPermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
});
export type CursorAcpPermissionOption = typeof CursorAcpPermissionOption.Type;

export const CursorAcpPermissionRequest = Schema.Struct({
  jsonrpc: Schema.optional(Schema.Literal("2.0")),
  id: CursorAcpJsonRpcId,
  method: Schema.Literal("session/request_permission"),
  params: Schema.Struct({
    sessionId: Schema.String,
    toolCall: Schema.optional(Schema.Unknown),
    options: Schema.Array(CursorAcpPermissionOption),
  }),
});
export type CursorAcpPermissionRequest = typeof CursorAcpPermissionRequest.Type;

export const CursorAcpInitializeResult = Schema.Struct({
  protocolVersion: Schema.optional(Schema.Int),
  agentCapabilities: Schema.optional(Schema.Unknown),
  authMethods: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type CursorAcpInitializeResult = typeof CursorAcpInitializeResult.Type;

export const CursorAcpSessionNewResult = Schema.Struct({
  sessionId: Schema.String,
  modes: Schema.optional(Schema.Unknown),
});
export type CursorAcpSessionNewResult = typeof CursorAcpSessionNewResult.Type;

export const CursorAcpSessionPromptResult = Schema.Struct({
  stopReason: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Unknown),
});
export type CursorAcpSessionPromptResult = typeof CursorAcpSessionPromptResult.Type;

export interface CursorAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "cursor";
}

export class CursorAdapter extends ServiceMap.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Services/CursorAdapter",
) {}
