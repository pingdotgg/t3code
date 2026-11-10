// Lenient decoders for the ZeroClaw RPC subset this adapter uses.
// Unknown session/update types decode as a catch-all rather than failing the turn.
// The daemon's wire keys are snake_case (zeroclaw-runtime rpc/types.rs);
// `encodeKeys` maps them onto the camelCase shapes the adapter uses.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const InitializeResult = Schema.Struct({
  protocolVersion: Schema.Number,
  serverVersion: Schema.optional(Schema.String),
}).pipe(
  Schema.encodeKeys({ protocolVersion: "protocol_version", serverVersion: "server_version" }),
);

const StatusResult = Schema.Struct({
  version: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ version: "server_version" }));

const AgentInfo = Schema.Struct({
  alias: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
});

const AgentsListResult = Schema.Struct({
  agents: Schema.Array(AgentInfo),
});

const SessionNewResult = Schema.Struct({
  sessionId: Schema.String,
  agentAlias: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ sessionId: "session_id", agentAlias: "agent_alias" }));

const SessionPromptResult = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ sessionId: "session_id", stopReason: "stop_reason" }));

const SessionStateResult = Schema.Struct({
  sessionId: Schema.String,
  state: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ sessionId: "session_id", turnId: "turn_id" }));

const ConversationMessage = Schema.Struct({
  kind: Schema.optional(Schema.String),
  role: Schema.String,
  content: Schema.optional(Schema.String),
});

const SessionMessagesResult = Schema.Struct({
  messages: Schema.Array(ConversationMessage),
});

const ApprovalRequestUpdate = Schema.Struct({
  type: Schema.Literal("approval_request"),
  sessionId: Schema.optional(Schema.String),
  requestId: Schema.String,
  toolName: Schema.String,
  argumentsSummary: Schema.optional(Schema.String),
  timeoutSecs: Schema.optional(Schema.Number),
}).pipe(
  Schema.encodeKeys({
    sessionId: "session_id",
    requestId: "request_id",
    toolName: "tool_name",
    argumentsSummary: "arguments_summary",
    timeoutSecs: "timeout_secs",
  }),
);

const TurnCompleteUpdate = Schema.Struct({
  type: Schema.Literal("turn_complete"),
  sessionId: Schema.optional(Schema.String),
  outcome: Schema.Literals(["completed", "cancelled", "failed"]),
  /** Final text when completed, partial text when cancelled, the error when failed. */
  content: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ sessionId: "session_id" }));

const TextChunkUpdate = Schema.Struct({
  type: Schema.Literals(["agent_message_chunk", "agent_thought_chunk"]),
  sessionId: Schema.optional(Schema.String),
  text: Schema.String,
}).pipe(Schema.encodeKeys({ sessionId: "session_id" }));

const ToolCallUpdate = Schema.Struct({
  type: Schema.Literal("tool_call"),
  sessionId: Schema.optional(Schema.String),
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.optional(Schema.Unknown),
}).pipe(
  Schema.encodeKeys({ sessionId: "session_id", toolCallId: "tool_call_id", input: "raw_input" }),
);

const ToolResultUpdate = Schema.Struct({
  type: Schema.Literal("tool_result"),
  sessionId: Schema.optional(Schema.String),
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["completed", "failed"])),
  output: Schema.optional(Schema.Unknown),
}).pipe(
  Schema.encodeKeys({ sessionId: "session_id", toolCallId: "tool_call_id", output: "raw_output" }),
);

const PlanUpdate = Schema.Struct({
  type: Schema.Literal("plan"),
  sessionId: Schema.optional(Schema.String),
  items: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      /** `pending` | `in_progress` | `completed` on the wire. */
      status: Schema.optional(Schema.String),
    }),
  ),
}).pipe(Schema.encodeKeys({ sessionId: "session_id", items: "entries" }));

const ContextUsageUpdate = Schema.Struct({
  type: Schema.Literal("context_usage"),
  sessionId: Schema.optional(Schema.String),
  usedTokens: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
}).pipe(
  Schema.encodeKeys({
    sessionId: "session_id",
    usedTokens: "input_tokens",
    maxTokens: "max_context_tokens",
  }),
);

const HistoryTrimmedUpdate = Schema.Struct({
  type: Schema.Literal("history_trimmed"),
  sessionId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  droppedMessages: Schema.optional(Schema.Number),
}).pipe(Schema.encodeKeys({ sessionId: "session_id", droppedMessages: "dropped_messages" }));

const BudgetWarningUpdate = Schema.Struct({
  type: Schema.Literal("budget_warning"),
  sessionId: Schema.optional(Schema.String),
  currentUsd: Schema.optional(Schema.Number),
  limitUsd: Schema.optional(Schema.Number),
  period: Schema.optional(Schema.String),
}).pipe(
  Schema.encodeKeys({ sessionId: "session_id", currentUsd: "current_usd", limitUsd: "limit_usd" }),
);

/** Catch-all so a daemon that adds an update type does not fail the turn. */
const UnknownSessionUpdate = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
}).pipe(Schema.encodeKeys({ sessionId: "session_id" }));

const KnownSessionUpdate = Schema.Union([
  TextChunkUpdate,
  ToolCallUpdate,
  ToolResultUpdate,
  ApprovalRequestUpdate,
  PlanUpdate,
  ContextUsageUpdate,
  HistoryTrimmedUpdate,
  BudgetWarningUpdate,
  TurnCompleteUpdate,
]);

const KNOWN_UPDATE_TYPES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_result",
  "approval_request",
  "plan",
  "context_usage",
  "history_trimmed",
  "budget_warning",
  "turn_complete",
]);

export const SessionUpdate = Schema.Union([KnownSessionUpdate, UnknownSessionUpdate]);
export type SessionUpdate = typeof SessionUpdate.Type;

const decodeKnownSessionUpdate = Schema.decodeUnknownEffect(KnownSessionUpdate);
const decodeUnknownSessionUpdate = Schema.decodeUnknownEffect(UnknownSessionUpdate);

/**
 * Known update types decode strictly. Anything else becomes the catch-all so a
 * daemon that adds a type does not fail the turn, while a malformed known type
 * still fails instead of being silently ignored.
 */
export const decodeSessionUpdate = (input: unknown) => {
  const type =
    typeof input === "object" && input !== null && "type" in input
      ? (input as { type?: unknown }).type
      : undefined;
  if (typeof type === "string" && !KNOWN_UPDATE_TYPES.has(type)) {
    return decodeUnknownSessionUpdate(input);
  }
  return decodeKnownSessionUpdate(input);
};

export const decodeInitializeResult = Schema.decodeUnknownEffect(InitializeResult);

/**
 * `initialize` params. No `elicitation` key means the daemon never sends
 * `elicitation/create`; note that `elicitation: {}` would mean form support.
 */
export const INITIALIZE_PARAMS = { protocol_version: 1, clientCapabilities: {} } as const;

/** JSON-RPC "method not found", returned for any daemon → client request. */
export const UNSUPPORTED_REQUEST_ERROR = {
  code: -32601,
  message: "T3 Code does not handle ZeroClaw client requests (elicitation is unsupported).",
} as const;
export const decodeStatusResult = Schema.decodeUnknownEffect(StatusResult);
export const decodeAgentsListResult = Schema.decodeUnknownEffect(AgentsListResult);
export const decodeSessionNewResult = Schema.decodeUnknownEffect(SessionNewResult);
export const decodeSessionPromptResult = Schema.decodeUnknownEffect(SessionPromptResult);
export const decodeSessionStateResult = Schema.decodeUnknownEffect(SessionStateResult);
export const decodeSessionMessagesResult = Schema.decodeUnknownEffect(SessionMessagesResult);
export const decodeSessionUpdateSync = (input: unknown) =>
  Effect.runSync(decodeSessionUpdate(input));
