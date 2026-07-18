import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type * as PtyAdapter from "../terminal/PtyAdapter.ts";

/**
 * Matches common CSI / OSC ANSI escape sequences emitted by interactive CLI
 * output. Shared by every PTY-backed usage probe.
 */
const ESCAPE_CHAR = String.fromCharCode(27);
const BEL_CHAR = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESCAPE_CHAR}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL_CHAR}]*(?:${BEL_CHAR}|${ESCAPE_CHAR}\\\\))`,
  "g",
);

export function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, "");
}

export interface ProbeClock {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
}

export const defaultProbeClock: ProbeClock = { setTimeout, clearTimeout };

/** Best-effort kill during probe cleanup; the process may have already exited. */
export function killPtyProcessQuietly(child: PtyAdapter.PtyProcess): void {
  try {
    child.kill();
  } catch {
    // Ignore kill failures during cleanup.
  }
}

const RESET_YEAR_ROLLOVER_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Usage-probe output often reports a reset date without a year (e.g. "Jan 3,
 * 9:00am"). Callers assume the reset falls in the same year as `checkedAt`,
 * which is wrong when the probe runs near year-end for a reset that rolls
 * into January (e.g. checked Dec 30, reset Jan 3 of the *following* year).
 * Roll the year forward when the assumed-year date lands more than a day in
 * the past relative to `checkedAt`. No-ops when the source text already had
 * an explicit year.
 */
export function rollResetYearForward<A extends DateTime.DateTime>(
  resetDateTime: A,
  checkedAt: string,
  hadExplicitYear: boolean,
): A {
  if (hadExplicitYear) {
    return resetDateTime;
  }
  const checked = DateTime.make(checkedAt);
  if (Option.isNone(checked)) {
    return resetDateTime;
  }
  if (
    DateTime.toEpochMillis(resetDateTime) >=
    DateTime.toEpochMillis(checked.value) - RESET_YEAR_ROLLOVER_GRACE_MS
  ) {
    return resetDateTime;
  }
  return DateTime.add(resetDateTime, { years: 1 });
}
