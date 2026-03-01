import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProviderItemId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "./baseSchemas";
import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderKind,
  ProviderRequestKind,
  ProviderSandboxMode,
  TurnCountRange,
} from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);
export type ProviderSessionStatus = typeof ProviderSessionStatus.Type;

export const ProviderSession = Schema.Struct({
  sessionId: ProviderSessionId,
  provider: ProviderKind,
  status: ProviderSessionStatus,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  threadId: Schema.optional(ProviderThreadId),
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(ProviderTurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderSession = typeof ProviderSession.Type;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
  homePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CodexProviderStartOptions = typeof CodexProviderStartOptions.Type;

export const ClaudeCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
  permissionMode: Schema.optional(TrimmedNonEmptyStringSchema),
  maxThinkingTokens: Schema.optional(NonNegativeInt),
});
export type ClaudeCodeProviderStartOptions = typeof ClaudeCodeProviderStartOptions.Type;

export const CursorProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CursorProviderStartOptions = typeof CursorProviderStartOptions.Type;

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  claudeCode: Schema.optional(ClaudeCodeProviderStartOptions),
  cursor: Schema.optional(CursorProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;

export const ProviderSessionStartInput = Schema.Struct({
  provider: Schema.optional(ProviderKind),
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  resumeCursor: Schema.optional(Schema.Unknown),
  providerOptions: Schema.optional(ProviderStartOptions),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  sessionId: ProviderSessionId,
  input: Schema.optional(
    TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: Schema.optional(ProviderThreadId),
  turnId: ProviderTurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  sessionId: ProviderSessionId,
  turnId: Schema.optional(ProviderTurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  sessionId: ProviderSessionId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderListCheckpointsInput = Schema.Struct({
  sessionId: ProviderSessionId,
});
export type ProviderListCheckpointsInput = typeof ProviderListCheckpointsInput.Type;

export const ProviderCheckpoint = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  turnCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  label: TrimmedNonEmptyStringSchema,
  preview: Schema.optional(TrimmedNonEmptyStringSchema),
  isCurrent: Schema.Boolean,
});
export type ProviderCheckpoint = typeof ProviderCheckpoint.Type;

export const ProviderListCheckpointsResult = Schema.Struct({
  threadId: ThreadId,
  checkpoints: Schema.Array(ProviderCheckpoint),
});
export type ProviderListCheckpointsResult = typeof ProviderListCheckpointsResult.Type;

export const ProviderRevertToCheckpointInput = Schema.Struct({
  sessionId: ProviderSessionId,
  turnCount: NonNegativeInt,
});
export type ProviderRevertToCheckpointInput = typeof ProviderRevertToCheckpointInput.Type;

export const ProviderRevertToCheckpointResult = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  messageCount: NonNegativeInt,
  rolledBackTurns: NonNegativeInt,
  checkpoints: Schema.Array(ProviderCheckpoint),
});
export type ProviderRevertToCheckpointResult = typeof ProviderRevertToCheckpointResult.Type;

export const ProviderGetCheckpointDiffInput = Schema.Struct({
  sessionId: ProviderSessionId,
  ...TurnCountRange.fields,
});
export type ProviderGetCheckpointDiffInput = typeof ProviderGetCheckpointDiffInput.Type;

export const ProviderGetCheckpointDiffResult = Schema.Struct({
  threadId: ThreadId,
  ...TurnCountRange.fields,
  diff: Schema.String,
});
export type ProviderGetCheckpointDiffResult = typeof ProviderGetCheckpointDiffResult.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  sessionId: ProviderSessionId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);
export type ProviderEventKind = typeof ProviderEventKind.Type;

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderKind,
  sessionId: ProviderSessionId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyStringSchema,
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  threadId: Schema.optional(ProviderThreadId),
  turnId: Schema.optional(ProviderTurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;

export type ProviderSendTurnAttachment = typeof ChatAttachment.Type;
export type ProviderSendTurnAttachmentInput = typeof ChatAttachment.Type;
