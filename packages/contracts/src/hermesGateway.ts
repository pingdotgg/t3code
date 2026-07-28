import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const HermesGatewayJsonRpcVersion = Schema.Literal("2.0");
export type HermesGatewayJsonRpcVersion = typeof HermesGatewayJsonRpcVersion.Type;

export const HermesGatewayJsonRpcId = Schema.Union([Schema.String, Schema.Number]);
export type HermesGatewayJsonRpcId = typeof HermesGatewayJsonRpcId.Type;

export const HermesGatewayUnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
export type HermesGatewayUnknownRecord = typeof HermesGatewayUnknownRecord.Type;

export const HermesGatewayRequest = Schema.Struct({
  jsonrpc: HermesGatewayJsonRpcVersion,
  id: HermesGatewayJsonRpcId,
  method: Schema.NonEmptyString,
  params: HermesGatewayUnknownRecord,
});
export type HermesGatewayRequest = typeof HermesGatewayRequest.Type;

export const HermesGatewayNotification = Schema.Struct({
  jsonrpc: HermesGatewayJsonRpcVersion,
  method: Schema.NonEmptyString,
  params: Schema.optional(Schema.Unknown),
});
export type HermesGatewayNotification = typeof HermesGatewayNotification.Type;

export const HermesGatewayErrorDisposition = Schema.Literals([
  "retryable",
  "indeterminate",
  "fatal",
]);
export type HermesGatewayErrorDisposition = typeof HermesGatewayErrorDisposition.Type;

export const HermesGatewayMutationStatus = Schema.Literals([
  "admitted",
  "completed",
  "indeterminate",
]);
export type HermesGatewayMutationStatus = typeof HermesGatewayMutationStatus.Type;

export const HermesGatewayMutationOutcome = Schema.Union([
  Schema.Struct({
    mutation_status: Schema.Literal("admitted"),
  }),
  Schema.Struct({
    mutation_status: Schema.Literal("completed"),
  }),
  Schema.Struct({
    mutation_id: Schema.String,
    mutation_status: Schema.Literal("indeterminate"),
    run_id: Schema.String,
    replayed: Schema.Literal(true),
  }),
]);
export type HermesGatewayMutationOutcome = typeof HermesGatewayMutationOutcome.Type;

export const HermesGatewayMutationStatusParams = Schema.Struct({
  mutation_id: Schema.String,
});
export type HermesGatewayMutationStatusParams = typeof HermesGatewayMutationStatusParams.Type;

export const HermesGatewayMutationStatusResult = HermesGatewayMutationOutcome;
export type HermesGatewayMutationStatusResult = typeof HermesGatewayMutationStatusResult.Type;

export const HermesGatewayJsonRpcError = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(
    Schema.Struct({
      disposition: Schema.optional(HermesGatewayErrorDisposition),
      admitted: Schema.optional(Schema.Boolean),
      mutation_id: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type HermesGatewayJsonRpcError = typeof HermesGatewayJsonRpcError.Type;

export const HermesGatewaySuccessResponse = Schema.Struct({
  jsonrpc: HermesGatewayJsonRpcVersion,
  id: HermesGatewayJsonRpcId,
  result: Schema.Unknown,
});
export type HermesGatewaySuccessResponse = typeof HermesGatewaySuccessResponse.Type;

export const HermesGatewayErrorResponse = Schema.Struct({
  jsonrpc: HermesGatewayJsonRpcVersion,
  id: Schema.NullOr(HermesGatewayJsonRpcId),
  error: HermesGatewayJsonRpcError,
});
export type HermesGatewayErrorResponse = typeof HermesGatewayErrorResponse.Type;

export const HermesGatewayResponse = Schema.Union([
  HermesGatewaySuccessResponse,
  HermesGatewayErrorResponse,
]);
export type HermesGatewayResponse = typeof HermesGatewayResponse.Type;

export const HermesGatewayKnownEventType = Schema.Literals([
  "gateway.ready",
  "session.info",
  "title.changed",
  "session.status",
  "status.update",
  "message.start",
  "message.delta",
  "message.interim",
  "message.complete",
  "thinking.delta",
  "reasoning.delta",
  "reasoning.available",
  "tool.generating",
  "tool.progress",
  "tool.start",
  "tool.complete",
  "tool.output_risk",
  "approval.request",
  "clarify.request",
  "error",
]);
export type HermesGatewayKnownEventType = typeof HermesGatewayKnownEventType.Type;

export const HermesGatewayEventParams = Schema.Struct({
  type: Schema.NonEmptyString,
  session_id: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
  event_id: Schema.optional(Schema.String),
  event_sequence: Schema.optional(Schema.Number),
  emitted_at: Schema.optional(Schema.String),
  session_key: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
  message_id: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  mutation_id: Schema.optional(Schema.String),
});
export type HermesGatewayEventParams = typeof HermesGatewayEventParams.Type;

export const HermesGatewayEvent = Schema.Struct({
  jsonrpc: HermesGatewayJsonRpcVersion,
  method: Schema.Literal("event"),
  params: HermesGatewayEventParams,
});
export type HermesGatewayEvent = typeof HermesGatewayEvent.Type;

export const HermesGatewayInboundFrame = Schema.Union([
  HermesGatewaySuccessResponse,
  HermesGatewayErrorResponse,
  HermesGatewayEvent,
  HermesGatewayNotification,
]);
export type HermesGatewayInboundFrame = typeof HermesGatewayInboundFrame.Type;

export const HermesGatewayCapabilityName = Schema.NonEmptyString;
export type HermesGatewayCapabilityName = typeof HermesGatewayCapabilityName.Type;

export const HermesGatewayCapabilityInventory = Schema.Union([
  Schema.Array(HermesGatewayCapabilityName),
  Schema.Record(HermesGatewayCapabilityName, Schema.Unknown),
]);
export type HermesGatewayCapabilityInventory = typeof HermesGatewayCapabilityInventory.Type;

export const HermesGatewayProtocolVersion = Schema.Struct({
  major: NonNegativeInt,
  minor: NonNegativeInt,
  build_revision: Schema.optional(Schema.String),
  capabilities: Schema.optional(HermesGatewayCapabilityInventory),
});
export type HermesGatewayProtocolVersion = typeof HermesGatewayProtocolVersion.Type;

export const HermesGatewayReadyPayload = Schema.Struct({
  skin: Schema.optional(Schema.String),
  protocol: Schema.optional(HermesGatewayProtocolVersion),
  // Kept for pre-negotiation development builds that advertised at payload level.
  capabilities: Schema.optional(HermesGatewayCapabilityInventory),
  server_version: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.String),
});
export type HermesGatewayReadyPayload = typeof HermesGatewayReadyPayload.Type;

export const HermesGatewayReadyEvent = Schema.Struct({
  jsonrpc: HermesGatewayJsonRpcVersion,
  method: Schema.Literal("event"),
  params: Schema.Struct({
    type: Schema.Literal("gateway.ready"),
    session_id: Schema.optional(Schema.String),
    payload: HermesGatewayReadyPayload,
    event_id: Schema.optional(Schema.String),
    event_sequence: Schema.optional(Schema.Number),
    emitted_at: Schema.optional(Schema.String),
    session_key: Schema.optional(Schema.String),
    run_id: Schema.optional(Schema.String),
    message_id: Schema.optional(Schema.String),
    cursor: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  }),
});
export type HermesGatewayReadyEvent = typeof HermesGatewayReadyEvent.Type;

export const HermesGatewayCompatibilityStatus = Schema.Literals([
  "supported",
  "legacy",
  "unsupported",
]);
export type HermesGatewayCompatibilityStatus = typeof HermesGatewayCompatibilityStatus.Type;

export const HermesGatewayCompatibility = Schema.Struct({
  status: HermesGatewayCompatibilityStatus,
  protocol: Schema.NullOr(HermesGatewayProtocolVersion),
  capabilities: Schema.Array(HermesGatewayCapabilityName),
  inventory: Schema.NullOr(HermesGatewayCapabilityInventory),
  reason: Schema.String,
  serverVersion: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.String),
});
export type HermesGatewayCompatibility = typeof HermesGatewayCompatibility.Type;

export const HermesGatewayMessageEventPayload = Schema.Struct({
  text: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  message_id: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
});
export type HermesGatewayMessageEventPayload = typeof HermesGatewayMessageEventPayload.Type;

export const HermesGatewayToolEventPayload = Schema.Struct({
  tool_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  args_text: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  arguments: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  result_text: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  duration_s: Schema.optional(Schema.Number),
  duration: Schema.optional(Schema.Number),
  todos: Schema.optional(Schema.Array(Schema.Unknown)),
  inline_diff: Schema.optional(Schema.String),
  risk: Schema.optional(Schema.String),
  findings: Schema.optional(Schema.Array(Schema.String)),
  redacted: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.Unknown),
});
export type HermesGatewayToolEventPayload = typeof HermesGatewayToolEventPayload.Type;

export const HermesGatewayApprovalEventPayload = Schema.Struct({
  command: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.Array(Schema.String)),
  allow_permanent: Schema.optional(Schema.Boolean),
  smart_denied: Schema.optional(Schema.Boolean),
});
export type HermesGatewayApprovalEventPayload = typeof HermesGatewayApprovalEventPayload.Type;

export const HermesGatewayClarificationEventPayload = Schema.Struct({
  request_id: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
export type HermesGatewayClarificationEventPayload =
  typeof HermesGatewayClarificationEventPayload.Type;

export const HermesGatewayCommandsCatalogResult = Schema.Struct({
  pairs: Schema.optional(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
  sub: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  canon: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  categories: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        pairs: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      }),
    ),
  ),
  skill_count: Schema.optional(Schema.Number),
  warning: Schema.optional(Schema.String),
});
export type HermesGatewayCommandsCatalogResult = typeof HermesGatewayCommandsCatalogResult.Type;

export const HermesGatewayModelOptionProvider = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  models: Schema.optional(Schema.Array(Schema.String)),
  is_current: Schema.optional(Schema.Boolean),
  authenticated: Schema.optional(Schema.Boolean),
  total_models: Schema.optional(Schema.Number),
  warning: Schema.optional(Schema.String),
  capabilities: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        fast: Schema.optional(Schema.Boolean),
        reasoning: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type HermesGatewayModelOptionProvider = typeof HermesGatewayModelOptionProvider.Type;

export const HermesGatewayModelOptionsResult = Schema.Struct({
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Array(HermesGatewayModelOptionProvider)),
});
export type HermesGatewayModelOptionsResult = typeof HermesGatewayModelOptionsResult.Type;

export const HermesGatewayReasoningConfigResult = Schema.Struct({
  value: Schema.String,
  display: Schema.optional(Schema.Literals(["show", "hide"])),
});
export type HermesGatewayReasoningConfigResult = typeof HermesGatewayReasoningConfigResult.Type;

export const HermesGatewayFastConfigResult = Schema.Struct({
  value: Schema.Literals(["normal", "fast"]),
});
export type HermesGatewayFastConfigResult = typeof HermesGatewayFastConfigResult.Type;

export const HermesGatewayApprovalRespondParams = Schema.Struct({
  session_id: Schema.String,
  choice: Schema.Literals(["once", "session", "deny"]),
});
export type HermesGatewayApprovalRespondParams = typeof HermesGatewayApprovalRespondParams.Type;

export const HermesGatewayApprovalRespondResult = Schema.Struct({
  resolved: Schema.Boolean,
});
export type HermesGatewayApprovalRespondResult = typeof HermesGatewayApprovalRespondResult.Type;

export const HermesGatewayClarificationRespondParams = Schema.Struct({
  request_id: Schema.String,
  answer: Schema.String,
});
export type HermesGatewayClarificationRespondParams =
  typeof HermesGatewayClarificationRespondParams.Type;

export const HermesGatewayClarificationRespondResult = Schema.Struct({
  status: Schema.Literals(["ok", "expired"]),
});
export type HermesGatewayClarificationRespondResult =
  typeof HermesGatewayClarificationRespondResult.Type;

export const HermesGatewayHistoryMessage = Schema.Struct({
  message_id: Schema.optional(Schema.String),
  role: Schema.Literals(["user", "assistant", "tool", "system"]),
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Unknown),
  tool_call_id: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Unknown),
  reasoning_content: Schema.optional(Schema.Unknown),
  reasoning_details: Schema.optional(Schema.Unknown),
  codex_reasoning_items: Schema.optional(Schema.Unknown),
  display_kind: Schema.optional(Schema.String),
  display_metadata: Schema.optional(Schema.Unknown),
});
export type HermesGatewayHistoryMessage = typeof HermesGatewayHistoryMessage.Type;

export const HermesGatewaySessionInfo = Schema.Struct({
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  reasoning_effort: Schema.optional(Schema.String),
  service_tier: Schema.optional(Schema.String),
  fast: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  project: Schema.optional(Schema.Unknown),
  tools: Schema.optional(Schema.Unknown),
  skills: Schema.optional(Schema.Unknown),
  lazy: Schema.optional(Schema.Boolean),
  desktop_contract: Schema.optional(Schema.Number),
  profile_name: Schema.optional(Schema.String),
  title_revision: Schema.optional(Schema.Number),
  title_origin: Schema.optional(Schema.String),
});
export type HermesGatewaySessionInfo = typeof HermesGatewaySessionInfo.Type;

export const HermesGatewayTitleOrigin = Schema.NonEmptyString;
export type HermesGatewayTitleOrigin = typeof HermesGatewayTitleOrigin.Type;

export const HermesGatewaySessionTitleParams = Schema.Struct({
  session_id: Schema.String,
  title: Schema.optional(Schema.String),
  origin: Schema.optional(HermesGatewayTitleOrigin),
});
export type HermesGatewaySessionTitleParams = typeof HermesGatewaySessionTitleParams.Type;

export const HermesGatewaySessionTitleResult = Schema.Struct({
  session_key: Schema.String,
  title: Schema.optional(Schema.String),
  revision: NonNegativeInt,
  origin: HermesGatewayTitleOrigin,
  updated_at: Schema.optional(Schema.Number),
  pending: Schema.optional(Schema.Boolean),
});
export type HermesGatewaySessionTitleResult = typeof HermesGatewaySessionTitleResult.Type;

export const HermesGatewayTitleChangedEventPayload = Schema.Struct({
  session_key: Schema.String,
  title: Schema.String,
  revision: NonNegativeInt,
  origin: HermesGatewayTitleOrigin,
  updated_at: Schema.optional(Schema.Number),
  pending: Schema.optional(Schema.Boolean),
});
export type HermesGatewayTitleChangedEventPayload =
  typeof HermesGatewayTitleChangedEventPayload.Type;

export const HermesGatewaySessionBranchParams = Schema.Struct({
  session_id: Schema.String,
  name: Schema.optional(Schema.String),
  /**
   * Hermes accepts this only when it names the current transcript head.
   * It cannot branch an older message boundary.
   */
  boundary_message_id: Schema.optional(Schema.String),
});
export type HermesGatewaySessionBranchParams = typeof HermesGatewaySessionBranchParams.Type;

export const HermesGatewaySessionBranchResult = Schema.Struct({
  session_id: Schema.String,
  stored_session_id: Schema.String,
  title: Schema.String,
  parent: Schema.String,
  boundary: Schema.Struct({
    mode: Schema.Literal("latest_only"),
    exact: Schema.Literal(false),
    message_id: Schema.String,
    message_count: NonNegativeInt,
  }),
  mcp_revoked: Schema.optional(Schema.Boolean),
});
export type HermesGatewaySessionBranchResult = typeof HermesGatewaySessionBranchResult.Type;

export const HermesGatewaySessionCreateParams = Schema.Struct({
  cols: Schema.optional(Schema.Number),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
  title: Schema.optional(Schema.String),
  parent_session_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  reasoning_effort: Schema.optional(Schema.String),
  fast: Schema.optional(Schema.Boolean),
  close_on_disconnect: Schema.optional(Schema.Boolean),
  persist_immediately: Schema.optional(Schema.Boolean),
});
export type HermesGatewaySessionCreateParams = typeof HermesGatewaySessionCreateParams.Type;

export const HermesGatewaySessionCreateResult = Schema.Struct({
  session_id: Schema.String,
  stored_session_id: Schema.String,
  message_count: Schema.Number,
  messages: Schema.Array(HermesGatewayHistoryMessage),
  info: HermesGatewaySessionInfo,
});
export type HermesGatewaySessionCreateResult = typeof HermesGatewaySessionCreateResult.Type;

export const HermesGatewaySessionResumeParams = Schema.Struct({
  session_id: Schema.String,
  cols: Schema.optional(Schema.Number),
  profile: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  lazy: Schema.optional(Schema.Boolean),
  eager_build: Schema.optional(Schema.Boolean),
  close_on_disconnect: Schema.optional(Schema.Boolean),
});
export type HermesGatewaySessionResumeParams = typeof HermesGatewaySessionResumeParams.Type;

export const HermesGatewaySessionResumeResult = Schema.Struct({
  session_id: Schema.String,
  resumed: Schema.String,
  message_count: Schema.Number,
  messages: Schema.Array(HermesGatewayHistoryMessage),
  info: HermesGatewaySessionInfo,
  inflight: Schema.optional(Schema.Unknown),
  queued: Schema.optional(Schema.Unknown),
  running: Schema.Boolean,
  session_key: Schema.String,
  started_at: Schema.Number,
  status: Schema.String,
});
export type HermesGatewaySessionResumeResult = typeof HermesGatewaySessionResumeResult.Type;

export const HermesGatewaySessionHandleParams = Schema.Struct({
  session_id: Schema.String,
  profile: Schema.optional(Schema.String),
});
export type HermesGatewaySessionHandleParams = typeof HermesGatewaySessionHandleParams.Type;

export const HermesGatewayMcpServerConfig = Schema.Struct({
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type HermesGatewayMcpServerConfig = typeof HermesGatewayMcpServerConfig.Type;

export const HermesGatewaySessionMcpParams = Schema.Struct({
  session_id: Schema.String,
  servers: Schema.Record(Schema.String, HermesGatewayMcpServerConfig),
});
export type HermesGatewaySessionMcpParams = typeof HermesGatewaySessionMcpParams.Type;

export const HermesGatewaySessionMcpLeaseResult = Schema.Struct({
  lease_id: Schema.String,
  generation: NonNegativeInt,
  servers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      runtime_name: Schema.String,
    }),
  ),
  tool_names: Schema.Array(Schema.String),
  scope: Schema.Struct({
    session_id: Schema.String,
    session_key: Schema.String,
  }),
  persisted: Schema.Literal(false),
  history_recorded: Schema.Literal(false),
});
export type HermesGatewaySessionMcpLeaseResult = typeof HermesGatewaySessionMcpLeaseResult.Type;

export const HermesGatewaySessionMcpRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
  lease_id: Schema.NullOr(Schema.String),
  persisted: Schema.Literal(false),
});
export type HermesGatewaySessionMcpRevokeResult = typeof HermesGatewaySessionMcpRevokeResult.Type;

export const HermesGatewaySessionStatusResult = Schema.Struct({
  output: Schema.String,
});
export type HermesGatewaySessionStatusResult = typeof HermesGatewaySessionStatusResult.Type;

export const HermesGatewaySessionHistoryResult = Schema.Struct({
  count: Schema.Number,
  messages: Schema.Array(HermesGatewayHistoryMessage),
});
export type HermesGatewaySessionHistoryResult = typeof HermesGatewaySessionHistoryResult.Type;

/**
 * Durable, profile-scoped session summaries returned by the pinned
 * `session.list` protocol. The protocol intentionally does not expose
 * `parent_session_id`, so consumers must not infer child lineage from titles
 * or timestamps.
 */
export const HermesGatewayStoredSessionSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  started_at: Schema.Number,
  message_count: Schema.Number,
  source: Schema.String,
});
export type HermesGatewayStoredSessionSummary = typeof HermesGatewayStoredSessionSummary.Type;

export const HermesGatewaySessionListParams = Schema.Struct({
  profile: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});
export type HermesGatewaySessionListParams = typeof HermesGatewaySessionListParams.Type;

export const HermesGatewaySessionListResult = Schema.Struct({
  sessions: Schema.Array(HermesGatewayStoredSessionSummary),
});
export type HermesGatewaySessionListResult = typeof HermesGatewaySessionListResult.Type;

export const HermesGatewayPromptSubmitParams = Schema.Struct({
  session_id: Schema.String,
  text: Schema.String,
  interrupted: Schema.optional(Schema.Boolean),
  truncate_before_user_ordinal: Schema.optional(Schema.Number),
  confirm_empty_truncate: Schema.optional(Schema.Boolean),
});
export type HermesGatewayPromptSubmitParams = typeof HermesGatewayPromptSubmitParams.Type;

export const HermesGatewayPromptSubmitAdmittedResult = Schema.Struct({
  status: Schema.Literals(["streaming", "queued", "steered", "redirected"]),
  turn_isolation: Schema.optional(Schema.Boolean),
  run_id: Schema.optional(Schema.String),
  user_message_id: Schema.optional(Schema.String),
  assistant_message_id: Schema.optional(Schema.String),
  mutation_id: Schema.optional(Schema.String),
  replayed: Schema.optional(Schema.Boolean),
  mutation_status: Schema.optional(Schema.Literal("admitted")),
});
export type HermesGatewayPromptSubmitAdmittedResult =
  typeof HermesGatewayPromptSubmitAdmittedResult.Type;

export const HermesGatewayPromptSubmitTerminalResult = Schema.Struct({
  status: Schema.Literals(["complete", "interrupted", "error"]),
  turn_isolation: Schema.optional(Schema.Boolean),
  run_id: Schema.String,
  user_message_id: Schema.optional(Schema.String),
  assistant_message_id: Schema.optional(Schema.String),
  message_id: Schema.optional(Schema.String),
  mutation_id: Schema.String,
  replayed: Schema.optional(Schema.Boolean),
  mutation_status: Schema.Literal("completed"),
});
export type HermesGatewayPromptSubmitTerminalResult =
  typeof HermesGatewayPromptSubmitTerminalResult.Type;

export const HermesGatewayPromptSubmitResult = Schema.Union([
  HermesGatewayPromptSubmitAdmittedResult,
  HermesGatewayPromptSubmitTerminalResult,
]);
export type HermesGatewayPromptSubmitResult = typeof HermesGatewayPromptSubmitResult.Type;

export const HermesGatewayInterruptParams = Schema.Struct({
  session_id: Schema.String,
});
export type HermesGatewayInterruptParams = typeof HermesGatewayInterruptParams.Type;

export const HermesGatewayInterruptResult = Schema.Struct({
  status: Schema.Literal("interrupted"),
  turn_isolation: Schema.optional(Schema.Boolean),
});
export type HermesGatewayInterruptResult = typeof HermesGatewayInterruptResult.Type;

/**
 * Native Hermes cron is intentionally modelled separately from T3 scheduled
 * tasks. Hermes remains the scheduler of record and these values are a
 * projection of `cron.manage`, not locally persisted schedules.
 */
export const HermesGatewayCronJob = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  schedule: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  paused: Schema.optional(Schema.Boolean),
  next_run_at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  last_run_at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  created_at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  updated_at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  runs: Schema.optional(Schema.Array(Schema.Unknown)),
  executions: Schema.optional(Schema.Array(Schema.Unknown)),
  history: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type HermesGatewayCronJob = typeof HermesGatewayCronJob.Type;

export const HermesGatewayCronListResult = Schema.Struct({
  success: Schema.Boolean,
  jobs: Schema.Array(HermesGatewayCronJob),
});
export type HermesGatewayCronListResult = typeof HermesGatewayCronListResult.Type;

export const HermesGatewayCronMutationResult = Schema.Struct({
  success: Schema.Boolean,
  job_id: Schema.optional(Schema.String),
  job: Schema.optional(HermesGatewayCronJob),
  run_id: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type HermesGatewayCronMutationResult = typeof HermesGatewayCronMutationResult.Type;

export const HermesCronOperation = Schema.Literals([
  "create",
  "edit",
  "pause",
  "resume",
  "delete",
  "run_now",
]);
export type HermesCronOperation = typeof HermesCronOperation.Type;

export const HermesCronExecutionProvenance = Schema.Struct({
  scheduler: Schema.Literal("hermes"),
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  jobIdentity: Schema.String,
  upstreamRunId: Schema.NullOr(Schema.String),
  upstreamCursor: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  identityStrength: Schema.Literals(["upstream", "derived"]),
});
export type HermesCronExecutionProvenance = typeof HermesCronExecutionProvenance.Type;

export const HermesCronExecution = Schema.Struct({
  dedupeKey: Schema.String,
  status: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  completedAt: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  provenance: HermesCronExecutionProvenance,
});
export type HermesCronExecution = typeof HermesCronExecution.Type;

export const HermesCronJob = Schema.Struct({
  identity: Schema.String,
  identityStrength: Schema.Literals(["id", "name", "missing"]),
  id: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  schedule: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.String),
  enabled: Schema.NullOr(Schema.Boolean),
  nextRunAt: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  lastRunAt: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  executions: Schema.Array(HermesCronExecution),
});
export type HermesCronJob = typeof HermesCronJob.Type;

export const HermesCronCapabilities = Schema.Struct({
  inventory: Schema.Boolean,
  create: Schema.Boolean,
  edit: Schema.Boolean,
  pause: Schema.Boolean,
  resume: Schema.Boolean,
  delete: Schema.Boolean,
  runNow: Schema.Boolean,
});
export type HermesCronCapabilities = typeof HermesCronCapabilities.Type;

export const HermesCronProviderProjection = Schema.Struct({
  providerInstanceId: Schema.String,
  displayName: Schema.String,
  profileKey: Schema.String,
  status: Schema.Literals(["ready", "unavailable", "error"]),
  protocolClassification: Schema.NullOr(HermesGatewayCompatibilityStatus),
  capabilities: HermesCronCapabilities,
  jobs: Schema.Array(HermesCronJob),
  diagnostics: Schema.Array(Schema.String),
});
export type HermesCronProviderProjection = typeof HermesCronProviderProjection.Type;

export const HermesCronListInput = Schema.Struct({});
export type HermesCronListInput = typeof HermesCronListInput.Type;

export const HermesCronListResult = Schema.Struct({
  providers: Schema.Array(HermesCronProviderProjection),
});
export type HermesCronListResult = typeof HermesCronListResult.Type;

export const HermesCronMutationInput = Schema.Struct({
  providerInstanceId: Schema.String,
  operation: HermesCronOperation,
  operationId: Schema.String,
  jobIdentity: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  schedule: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
});
export type HermesCronMutationInput = typeof HermesCronMutationInput.Type;

export const HermesCronMutationResponse = Schema.Struct({
  provider: HermesCronProviderProjection,
  upstreamJobId: Schema.NullOr(Schema.String),
  upstreamRunId: Schema.NullOr(Schema.String),
});
export type HermesCronMutationResponse = typeof HermesCronMutationResponse.Type;

export class HermesCronError extends Schema.TaggedErrorClass<HermesCronError>()("HermesCronError", {
  code: Schema.Literals([
    "provider_not_found",
    "provider_unavailable",
    "unsupported_operation",
    "invalid_input",
    "gateway_error",
    "indeterminate",
  ]),
  message: Schema.String,
  providerInstanceId: Schema.optional(Schema.String),
  operation: Schema.optional(HermesCronOperation),
}) {}
