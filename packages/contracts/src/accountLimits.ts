/**
 * Account rate-limit contract.
 *
 * Providers meter subscription usage in rolling windows (Claude: 5-hour and
 * weekly; Codex: weekly today, 5-hour whenever OpenAI turns it back on). Each
 * environment folds whatever the provider streams into one snapshot per
 * provider instance and serves it here; the client keeps one row per
 * (environment, provider, instance) and never merges across environments -
 * two machines' clocks cannot arbitrate freshness for each other.
 *
 * Windows are data, not schema: the set a provider reports changes without
 * notice (Codex paused its 5-hour window, Claude added model-scoped
 * weeklies), so clients render the array as-is and a window that reappears
 * upstream shows up again with zero client changes.
 *
 * @module accountLimits
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { UsageProviderKind } from "./usage.ts";

/**
 * Bumped whenever the shape of {@link AccountLimitsSummary} changes
 * incompatibly. The client skips summaries reporting another version rather
 * than failing the merge.
 *
 * v1: at most one snapshot per provider, no `instanceId`.
 * v2: at most one snapshot per provider instance. A v2-aware client also
 * accepts v1 summaries (folding them onto the driver's default instance);
 * a v1 client skips v2 summaries entirely - showing nothing beats showing
 * one instance's numbers as the whole provider's.
 */
export const ACCOUNT_LIMITS_CONTRACT_VERSION = 2 as const;
export const ACCOUNT_LIMITS_ACCEPTED_VERSIONS: readonly number[] = [1, 2];

export const AccountLimitsWindow = Schema.Struct({
  /**
   * Stable identifier: `five_hour` and `seven_day` for the standard windows,
   * provider-specific slugs for anything scoped (model weeklies etc.).
   */
  id: TrimmedNonEmptyString,
  /** Short display label ("5h", "Week", "Fable"). */
  label: TrimmedNonEmptyString,
  /** Share of the window consumed, 0-100. */
  usedPercent: Schema.Number,
  /**
   * ISO timestamp when the window resets. Null until the window has traffic:
   * providers report an untouched window with no reset clock.
   */
  resetsAt: Schema.NullOr(Schema.String),
  /** Window length, when the provider reports one. */
  windowMinutes: Schema.NullOr(Schema.Number),
});
export type AccountLimitsWindow = typeof AccountLimitsWindow.Type;

export const AccountLimitsSource = Schema.Literals(["live", "transcript"]);
export type AccountLimitsSource = typeof AccountLimitsSource.Type;

export const AccountLimitsSnapshot = Schema.Struct({
  provider: UsageProviderKind,
  /**
   * Routing key of the provider instance these windows were observed on.
   * Instances are the closest account identity every rate-limit event
   * already carries: two instances logged into different accounts must not
   * overwrite each other, and two logged into the same account simply show
   * the same numbers. Optional on the wire so summaries from servers that
   * predate instance attribution still decode; consumers treat an absent
   * value as the driver's default instance.
   */
  instanceId: Schema.optional(ProviderInstanceId),
  /** Provider plan slug ("max", "pro"), when known. */
  plan: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(AccountLimitsWindow),
  /**
   * When the provider reported these numbers, not when we were asked. Live
   * Claude data only flows while a session runs, so this can lag by hours;
   * clients surface the age instead of pretending the data is current.
   */
  asOf: Schema.String,
  /**
   * `live` - captured off a running provider session.
   * `transcript` - recovered from the provider's on-disk session files
   * (Codex writes its snapshot beside every token count; Claude never
   * persists limits, so Claude snapshots are always `live`).
   */
  source: AccountLimitsSource,
});
export type AccountLimitsSnapshot = typeof AccountLimitsSnapshot.Type;

export const AccountLimitsSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  /**
   * At most one snapshot per provider instance. Empty until a session has
   * reported.
   */
  snapshots: Schema.Array(AccountLimitsSnapshot),
});
export type AccountLimitsSummary = typeof AccountLimitsSummary.Type;
