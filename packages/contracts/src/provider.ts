import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderModelOptions } from "./model";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas";
import {
  ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderKind,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderServiceTier,
  ProviderStartOptions,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderKind,
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ProviderSession = typeof ProviderSession.Type;

export { ProviderStartOptions };

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderKind),
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  modelOptions: Schema.optional(ProviderModelOptions),
  resumeCursor: Schema.optional(Schema.Unknown),
  serviceTier: Schema.optional(Schema.NullOr(ProviderServiceTier)),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  serviceTier: Schema.optional(Schema.NullOr(ProviderServiceTier)),
  modelOptions: Schema.optional(ProviderModelOptions),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

// ── Provider model discovery ────────────────────────────────────────

export const ProviderListModelsInput = Schema.Struct({
  provider: ProviderKind,
});
export type ProviderListModelsInput = typeof ProviderListModelsInput.Type;

export interface ProviderModelOption {
  readonly slug: string;
  readonly name: string;
  readonly pricingTier?: string;
}

export interface ProviderListModelsResult {
  readonly models: ReadonlyArray<ProviderModelOption>;
}

// ── Provider usage / quota ──────────────────────────────────────────

export const ProviderGetUsageInput = Schema.Struct({
  provider: ProviderKind,
});
export type ProviderGetUsageInput = typeof ProviderGetUsageInput.Type;

export interface ProviderUsageQuota {
  readonly plan?: string;
  readonly used?: number;
  readonly limit?: number;
  readonly resetDate?: string;
  readonly percentUsed?: number;
}

export interface ProviderSessionUsage {
  readonly totalCostUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly totalTokens?: number;
  readonly turnCount?: number;
}

export interface ProviderModelMultiplier {
  readonly model: string;
  readonly name: string;
  readonly multiplier: number;
}

export interface ProviderUsageResult {
  readonly provider: string;
  readonly quota?: ProviderUsageQuota;
  readonly quotas?: ReadonlyArray<ProviderUsageQuota>;
  readonly sessionUsage?: ProviderSessionUsage;
  readonly modelMultipliers?: ReadonlyArray<ProviderModelMultiplier>;
}

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyStringSchema,
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
