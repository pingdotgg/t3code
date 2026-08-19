/**
 * Sanitized Vibe-Proxy quota reporting contracts.
 *
 * The upstream management response contains credential file paths and token
 * metadata. Those fields deliberately never cross T3 Code's wire. The server
 * normalizes only the account identity, request health, and quota capacity the
 * client needs to render the Usages page.
 *
 * @module vibeProxy
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VibeProxyQuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  resetAt: Schema.NullOr(Schema.String),
  known: Schema.Boolean,
  hardExhausted: Schema.Boolean,
  routing: Schema.Boolean,
});
export type VibeProxyQuotaWindow = typeof VibeProxyQuotaWindow.Type;

export const VibeProxyQuotaCapacity = Schema.Struct({
  provider: TrimmedNonEmptyString,
  supported: Schema.Boolean,
  fetchedAt: Schema.NullOr(Schema.String),
  staleAt: Schema.NullOr(Schema.String),
  lastAttemptAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  windows: Schema.Array(VibeProxyQuotaWindow),
});
export type VibeProxyQuotaCapacity = typeof VibeProxyQuotaCapacity.Type;

export const VibeProxyRecentRequestBucket = Schema.Struct({
  time: TrimmedNonEmptyString,
  success: NonNegativeInt,
  failed: NonNegativeInt,
});
export type VibeProxyRecentRequestBucket = typeof VibeProxyRecentRequestBucket.Type;

export const VibeProxyUsageAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  account: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  accountType: Schema.NullOr(Schema.String),
  planType: Schema.NullOr(Schema.String),
  status: TrimmedNonEmptyString,
  statusMessage: Schema.NullOr(Schema.String),
  disabled: Schema.Boolean,
  unavailable: Schema.Boolean,
  success: NonNegativeInt,
  failed: NonNegativeInt,
  recentRequests: Schema.Array(VibeProxyRecentRequestBucket),
  quotaCapacity: Schema.NullOr(VibeProxyQuotaCapacity),
});
export type VibeProxyUsageAccount = typeof VibeProxyUsageAccount.Type;

export const VibeProxyUsageSnapshot = Schema.Struct({
  fetchedAt: Schema.String,
  accounts: Schema.Array(VibeProxyUsageAccount),
});
export type VibeProxyUsageSnapshot = typeof VibeProxyUsageSnapshot.Type;

export const VibeProxyUsageRefreshProblem = Schema.Struct({
  reason: Schema.Literals([
    "invalidConfiguration",
    "unauthorized",
    "unreachable",
    "invalidResponse",
    "requestFailed",
  ]),
  message: TrimmedNonEmptyString,
});
export type VibeProxyUsageRefreshProblem = typeof VibeProxyUsageRefreshProblem.Type;

export const VibeProxyUsageResult = Schema.Struct({
  status: Schema.Literals(["disabled", "unconfigured", "ready"]),
  snapshot: Schema.NullOr(VibeProxyUsageSnapshot),
  /** True only when this response contains a newly fetched snapshot. */
  refreshed: Schema.Boolean,
  refreshProblem: Schema.NullOr(VibeProxyUsageRefreshProblem),
});
export type VibeProxyUsageResult = typeof VibeProxyUsageResult.Type;

export class VibeProxyUsageReadError extends Schema.TaggedErrorClass<VibeProxyUsageReadError>()(
  "VibeProxyUsageReadError",
  {
    operation: Schema.Literals(["read-cache", "write-cache"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Vibe-Proxy usage ${this.operation} failed.`;
  }
}
