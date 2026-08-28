/**
 * Usage limits contract.
 *
 * Environments report how much of each provider's subscription rate windows
 * is currently consumed (the figures behind "you are approaching your weekly
 * limit"). Limits only exist for subscription sign-ins: API keys are billed
 * per token and have no windows, so those providers answer with an
 * `unsupported` availability instead of numbers.
 *
 * Failures travel in-band per provider rather than failing the RPC: one
 * provider's expired login must not blank the others.
 *
 * @module usageLimits
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageLimitsSummary} changes
 * incompatibly. Clients drop environments reporting an older version from the
 * merged view rather than failing the page.
 */
export const USAGE_LIMITS_CONTRACT_VERSION = 1 as const;

/**
 * Providers that can report limits. Deliberately its own union rather than
 * {@link UsageProviderKind}: Grok reports subscription credits but has no
 * transcript-based usage aggregation, so the usage-summary contract must not
 * imply one exists.
 */
export const UsageLimitsProviderKind = Schema.Literals(["claude", "codex", "grok"]);
export type UsageLimitsProviderKind = typeof UsageLimitsProviderKind.Type;

/**
 * One rolling rate window, e.g. Claude's 5-hour session window or its weekly
 * all-model window.
 */
export const UsageLimitWindow = Schema.Struct({
  /** Stable provider-side identifier, e.g. `five_hour`, `seven_day`. */
  id: TrimmedNonEmptyString,
  /** Human label the client renders, e.g. "Current session". */
  label: TrimmedNonEmptyString,
  /** Cadence detail, e.g. "Resets every 5 hours". Null when unknown. */
  detail: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Percent of the window consumed, usually 0-100. Providers may briefly
   * report slightly more than 100 at the edge of a window.
   */
  utilization: Schema.Number,
  /** ISO instant the window resets, when the provider reports one. */
  resetsAt: Schema.NullOr(Schema.String),
});
export type UsageLimitWindow = typeof UsageLimitWindow.Type;

/**
 * Whether limit figures exist for a provider on this environment.
 *
 * - `available` - subscription sign-in with windows to show.
 * - `unsupported` - authenticated, but not through a subscription (API key,
 *   Bedrock, ...): there are no limit windows to report.
 * - `unauthenticated` - no usable credentials, or the provider rejected them.
 * - `unavailable` - credentials looked fine but the read failed (network,
 *   unexpected response shape).
 */
export const UsageLimitsAvailability = Schema.Literals([
  "available",
  "unsupported",
  "unauthenticated",
  "unavailable",
]);
export type UsageLimitsAvailability = typeof UsageLimitsAvailability.Type;

export const ProviderUsageLimits = Schema.Struct({
  provider: UsageLimitsProviderKind,
  availability: UsageLimitsAvailability,
  /** Subscription plan label, e.g. "Claude Max". Null when unknown. */
  plan: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Email of the signed-in account, when the provider exposes one. This is
   * what tells two accounts apart when environments report different
   * sign-ins of the same provider.
   */
  email: Schema.NullOr(TrimmedNonEmptyString),
  /** Empty unless `availability` is `available`. */
  windows: Schema.Array(UsageLimitWindow),
  /**
   * Why there are no figures, phrased for the page. Null when `available`.
   */
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderUsageLimits = typeof ProviderUsageLimits.Type;

export const UsageLimitsInput = Schema.Struct({});
export type UsageLimitsInput = typeof UsageLimitsInput.Type;

export const UsageLimitsSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  providers: Schema.Array(ProviderUsageLimits),
});
export type UsageLimitsSummary = typeof UsageLimitsSummary.Type;
