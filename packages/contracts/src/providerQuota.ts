/**
 * Provider remaining-quota contracts.
 *
 * These are current provider snapshots, deliberately separate from the
 * historical transcript-based UsageSummary contract. They contain only
 * normalized presentation data; credentials and raw provider payloads stay
 * inside the server adapter boundary.
 *
 * @module providerQuota
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const PROVIDER_QUOTA_ERROR_DETAIL_MAX_LENGTH = 512;
const ProviderQuotaErrorDetail = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_QUOTA_ERROR_DETAIL_MAX_LENGTH),
);

export const ProviderQuotaSnapshotStatus = Schema.Literals([
  "current",
  "unknown",
  "stale",
  "authRequired",
  "error",
]);
export type ProviderQuotaSnapshotStatus = typeof ProviderQuotaSnapshotStatus.Type;

export const ProviderQuotaMetric = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  remainingPercent: Schema.NullOr(Schema.Finite),
  usedPercent: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(Schema.String),
  windowMinutes: Schema.NullOr(NonNegativeInt),
  blocking: Schema.Boolean,
});
export type ProviderQuotaMetric = typeof ProviderQuotaMetric.Type;

export const ProviderQuotaCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(Schema.String),
});
export type ProviderQuotaCredits = typeof ProviderQuotaCredits.Type;

export const ProviderBankedReset = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(TrimmedNonEmptyString),
  grantedAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  resetType: TrimmedNonEmptyString,
  status: Schema.Literals(["available", "redeeming", "redeemed", "unknown"]),
});
export type ProviderBankedReset = typeof ProviderBankedReset.Type;

export const ProviderBankedResetSummary = Schema.Struct({
  availableCount: NonNegativeInt,
  resets: Schema.Array(ProviderBankedReset),
  detailsComplete: Schema.Boolean,
});
export type ProviderBankedResetSummary = typeof ProviderBankedResetSummary.Type;

export const ProviderQuotaSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  status: ProviderQuotaSnapshotStatus,
  source: TrimmedNonEmptyString,
  readAt: Schema.String,
  lastSuccessfulReadAt: Schema.NullOr(Schema.String),
  headlineMetricKey: Schema.NullOr(TrimmedNonEmptyString),
  metrics: Schema.Array(ProviderQuotaMetric),
  credits: Schema.NullOr(ProviderQuotaCredits),
  bankedResets: Schema.NullOr(ProviderBankedResetSummary),
  detail: Schema.Record(TrimmedNonEmptyString, Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type ProviderQuotaSnapshot = typeof ProviderQuotaSnapshot.Type;

export const ProviderQuotaSummary = Schema.Struct({
  readAt: Schema.String,
  instances: Schema.Array(ProviderQuotaSnapshot),
});
export type ProviderQuotaSummary = typeof ProviderQuotaSummary.Type;

export const ProviderQuotaConsumeResetInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  creditId: Schema.NullOr(TrimmedNonEmptyString),
  idempotencyKey: TrimmedNonEmptyString,
});
export type ProviderQuotaConsumeResetInput = typeof ProviderQuotaConsumeResetInput.Type;

export const ProviderQuotaConsumeResetOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderQuotaConsumeResetOutcome = typeof ProviderQuotaConsumeResetOutcome.Type;

/** Whole-service failures only; individual provider failures are snapshots. */
export class ProviderQuotaReadError extends Schema.TaggedErrorClass<ProviderQuotaReadError>()(
  "ProviderQuotaReadError",
  {
    reason: Schema.Literal("registryUnavailable"),
    detail: ProviderQuotaErrorDetail,
  },
) {}

export const ProviderQuotaConsumeResetErrorReason = Schema.Literals([
  "unsupported",
  "instanceMissing",
  "instanceDisabled",
  "authRequired",
  "providerFailed",
]);
export type ProviderQuotaConsumeResetErrorReason = typeof ProviderQuotaConsumeResetErrorReason.Type;

/** A bounded, normalized error safe to present after an explicit reset action. */
export class ProviderQuotaConsumeResetError extends Schema.TaggedErrorClass<ProviderQuotaConsumeResetError>()(
  "ProviderQuotaConsumeResetError",
  {
    reason: ProviderQuotaConsumeResetErrorReason,
    detail: ProviderQuotaErrorDetail,
  },
) {}
