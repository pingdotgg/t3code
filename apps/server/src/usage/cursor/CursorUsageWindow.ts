/**
 * Converts a `(sinceDay, untilDay, timeZone)` request window into the
 * millisecond range used to filter persisted events.
 *
 * The exact day boundary for an arbitrary IANA zone is computed later, in
 * `CursorUsageAggregation.ts`, against each event's own timestamp. This
 * helper only needs to bound the SQL query, so it pads generously (24h on
 * each side) rather than being exact - the same slack strategy
 * `UsageService`'s file scan uses for its own mtime filter.
 *
 * @module CursorUsageWindow
 */
const WINDOW_SLACK_MS = 24 * 60 * 60 * 1000;

export interface CursorUsageWindowInput {
  readonly sinceDay: string;
  readonly untilDay: string;
}

export interface CursorUsageWindowRangeMs {
  readonly sinceMs: number;
  /** Exclusive upper bound. */
  readonly untilMs: number;
}

export function resolveCursorUsageWindowRangeMs(
  input: CursorUsageWindowInput,
): CursorUsageWindowRangeMs {
  const sinceMs = Date.parse(`${input.sinceDay}T00:00:00Z`) - WINDOW_SLACK_MS;
  const untilMs = Date.parse(`${input.untilDay}T00:00:00Z`) + 24 * 60 * 60 * 1000 + WINDOW_SLACK_MS;
  return { sinceMs, untilMs };
}
