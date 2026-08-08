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
function killPtyProcessQuietly(child: PtyAdapter.PtyProcess): void {
  try {
    child.kill();
  } catch {
    // Ignore kill failures during cleanup.
  }
}

export type PtyProbeOutputDecision = "continue" | "finish" | { readonly settleAfterMs: number };

export function collectPtyProbeOutput(input: {
  readonly child: PtyAdapter.PtyProcess;
  readonly clock: ProbeClock;
  readonly timeoutMs: number;
  readonly onStart?: () => void;
  readonly decideAfterOutput?: (rawOutput: string) => PtyProbeOutputDecision;
}): Promise<string> {
  return new Promise((resolve) => {
    let rawOutput = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let offData: () => void = () => {};
    let offExit: () => void = () => {};

    const clearSettleTimer = () => {
      if (settleTimer) {
        input.clock.clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        input.clock.clearTimeout(timeout);
      }
      clearSettleTimer();
      offData();
      offExit();
      killPtyProcessQuietly(input.child);
      resolve(rawOutput);
    };

    offData = input.child.onData((data) => {
      if (settled) return;
      rawOutput += data;
      const decision = input.decideAfterOutput?.(rawOutput) ?? "continue";
      if (decision === "finish") {
        finish();
      } else if (decision === "continue") {
        clearSettleTimer();
      } else {
        clearSettleTimer();
        settleTimer = input.clock.setTimeout(finish, decision.settleAfterMs);
      }
    });
    offExit = input.child.onExit(finish);
    timeout = input.clock.setTimeout(finish, input.timeoutMs);

    try {
      input.onStart?.();
    } catch {
      finish();
    }
  });
}

/**
 * Usage-probe output often reports a reset date without a year (e.g. "Jan 3,
 * 9:00am"). Callers assume the reset falls in the same year as `checkedAt`,
 * which is wrong when the probe runs near year-end for a reset that rolls
 * into January (e.g. checked Dec 30, reset Jan 3 of the *following* year).
 * Roll the year forward only for the December-to-January boundary. Other past
 * yearless timestamps may be stale output and must not be moved a year ahead.
 * No-ops when the source text already had an explicit year.
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
  const checkedParts = DateTime.toPartsUtc(checked.value);
  const resetParts = DateTime.toParts(resetDateTime);
  if (
    checkedParts.month !== 12 ||
    resetParts.month !== 1 ||
    resetParts.year !== checkedParts.year
  ) {
    return resetDateTime;
  }
  return DateTime.add(resetDateTime, { years: 1 });
}
