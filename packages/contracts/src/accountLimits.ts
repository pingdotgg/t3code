/**
 * Account rate-limit contract.
 *
 * Providers meter subscription usage in rolling windows (Claude: 5-hour and
 * weekly; Codex: weekly today, 5-hour whenever OpenAI turns it back on). Each
 * environment folds whatever the provider streams into one snapshot per
 * provider account and serves it here; the client merges environments and
 * keeps the freshest snapshot per provider.
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
import { UsageProviderKind } from "./usage.ts";

/**
 * Bumped whenever the shape of {@link AccountLimitsSummary} changes
 * incompatibly. The client skips summaries reporting another version rather
 * than failing the merge.
 */
export const ACCOUNT_LIMITS_CONTRACT_VERSION = 1 as const;

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
  /** At most one snapshot per provider. Empty until a session has reported. */
  snapshots: Schema.Array(AccountLimitsSnapshot),
});
export type AccountLimitsSummary = typeof AccountLimitsSummary.Type;
