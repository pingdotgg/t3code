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

export const PROVIDER_QUOTA_IDENTIFIER_MAX_LENGTH = 128;
export const PROVIDER_QUOTA_DISPLAY_TEXT_MAX_LENGTH = 256;
export const PROVIDER_QUOTA_LONG_TEXT_MAX_LENGTH = 512;
export const PROVIDER_QUOTA_TIMESTAMP_MAX_LENGTH = 64;
export const PROVIDER_QUOTA_METRICS_MAX_ITEMS = 64;
export const PROVIDER_QUOTA_BANKED_RESETS_MAX_ITEMS = 32;
export const PROVIDER_QUOTA_DETAIL_MAX_PROPERTIES = 32;
export const PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES = 128;

const ProviderQuotaIdentifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_QUOTA_IDENTIFIER_MAX_LENGTH),
);
const ProviderQuotaDisplayText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_QUOTA_DISPLAY_TEXT_MAX_LENGTH),
);
const ProviderQuotaDisplayValue = Schema.String.check(
  Schema.isMaxLength(PROVIDER_QUOTA_DISPLAY_TEXT_MAX_LENGTH),
);
const ProviderQuotaLongText = Schema.String.check(
  Schema.isMaxLength(PROVIDER_QUOTA_LONG_TEXT_MAX_LENGTH),
);
const ProviderQuotaLongNonEmptyText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_QUOTA_LONG_TEXT_MAX_LENGTH),
);
const ProviderQuotaTimestamp = Schema.String.check(
  Schema.isMaxLength(PROVIDER_QUOTA_TIMESTAMP_MAX_LENGTH),
);
const ProviderQuotaErrorDetail = ProviderQuotaLongNonEmptyText;

export const ProviderQuotaSnapshotStatus = Schema.Literals([
  "current",
  "unknown",
  "stale",
  "authRequired",
  "error",
]);
export type ProviderQuotaSnapshotStatus = typeof ProviderQuotaSnapshotStatus.Type;

export const ProviderQuotaMetric = Schema.Struct({
  key: ProviderQuotaIdentifier,
  label: ProviderQuotaDisplayText,
  remainingPercent: Schema.NullOr(Schema.Finite),
  usedPercent: Schema.NullOr(Schema.Finite),
  resetsAt: Schema.NullOr(ProviderQuotaTimestamp),
  windowMinutes: Schema.NullOr(NonNegativeInt),
  blocking: Schema.Boolean,
});
export type ProviderQuotaMetric = typeof ProviderQuotaMetric.Type;

export const ProviderQuotaCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(ProviderQuotaDisplayValue),
});
export type ProviderQuotaCredits = typeof ProviderQuotaCredits.Type;

export const ProviderBankedReset = Schema.Struct({
  id: ProviderQuotaIdentifier,
  title: Schema.NullOr(ProviderQuotaDisplayText),
  description: Schema.NullOr(ProviderQuotaLongNonEmptyText),
  grantedAt: ProviderQuotaTimestamp,
  expiresAt: Schema.NullOr(ProviderQuotaTimestamp),
  resetType: ProviderQuotaIdentifier,
  status: Schema.Literals(["available", "redeeming", "redeemed", "unknown"]),
});
export type ProviderBankedReset = typeof ProviderBankedReset.Type;

export const ProviderBankedResetSummary = Schema.Struct({
  availableCount: NonNegativeInt,
  resets: Schema.Array(ProviderBankedReset).check(
    Schema.isMaxLength(PROVIDER_QUOTA_BANKED_RESETS_MAX_ITEMS),
  ),
  detailsComplete: Schema.Boolean,
});
export type ProviderBankedResetSummary = typeof ProviderBankedResetSummary.Type;

export const ProviderQuotaSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  status: ProviderQuotaSnapshotStatus,
  source: ProviderQuotaIdentifier,
  readAt: ProviderQuotaTimestamp,
  lastSuccessfulReadAt: Schema.NullOr(ProviderQuotaTimestamp),
  headlineMetricKey: Schema.NullOr(ProviderQuotaIdentifier),
  metrics: Schema.Array(ProviderQuotaMetric).check(
    Schema.isMaxLength(PROVIDER_QUOTA_METRICS_MAX_ITEMS),
  ),
  credits: Schema.NullOr(ProviderQuotaCredits),
  bankedResets: Schema.NullOr(ProviderBankedResetSummary),
  detail: Schema.Record(ProviderQuotaIdentifier, ProviderQuotaLongText).check(
    Schema.isMaxProperties(PROVIDER_QUOTA_DETAIL_MAX_PROPERTIES),
  ),
  message: Schema.NullOr(ProviderQuotaLongText),
});
export type ProviderQuotaSnapshot = typeof ProviderQuotaSnapshot.Type;

export const ProviderQuotaSummary = Schema.Struct({
  readAt: ProviderQuotaTimestamp,
  instances: Schema.Array(ProviderQuotaSnapshot).check(
    Schema.isMaxLength(PROVIDER_QUOTA_SUMMARY_MAX_INSTANCES),
  ),
});
export type ProviderQuotaSummary = typeof ProviderQuotaSummary.Type;

export const ProviderQuotaConsumeResetInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  creditId: Schema.NullOr(ProviderQuotaIdentifier),
  idempotencyKey: ProviderQuotaIdentifier,
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
    reason: Schema.Literals(["registryUnavailable", "instancesUnstable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "registryUnavailable"
      ? "Provider instances could not be listed."
      : "Provider instances did not stabilize while quota was read.";
  }
}

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
