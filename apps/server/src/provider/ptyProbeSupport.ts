import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as PtyAdapter from "../terminal/PtyAdapter.ts";

/** Extensions cmd.exe must interpret; they are not directly executable images. */
const WINDOWS_INTERPRETED_EXTENSIONS = [".cmd", ".bat"];

/**
 * Resolves a provider binary into something a PTY can actually launch.
 *
 * On Windows these CLIs install as `name.cmd` shims sitting next to an
 * extensionless shell script, and `PATH` lookup finds the latter. node-pty
 * spawns the target file directly instead of going through a shell, so handing
 * it the bare `claude` / `cursor` / `grok` path fails outright — which is why
 * every PTY-backed provider reported "Failed to spawn ... for usage probe" on
 * Windows while Codex (whose usage comes from an app-server RPC, not a PTY)
 * worked fine. `.cmd` shims are only executable through the command
 * interpreter, so route those via ComSpec.
 *
 * Deliberately does not reuse `resolveSpawnCommand`: that helper escapes the
 * executable for `ChildProcess` with `shell: true`, where the command is a
 * single string. node-pty instead takes an argv array and quotes each element
 * itself, so a pre-escaped path arrives double-quoted and cmd.exe rejects it
 * with "is not recognized as an internal or external command".
 */
export const resolvePtyProbeCommand = Effect.fn("resolvePtyProbeCommand")(function* (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32") {
    return { shell: binaryPath, args: [...args] };
  }

  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved = resolveExecutable(binaryPath, platform, env) ?? binaryPath;
  const lowerCased = resolved.toLowerCase();
  if (!WINDOWS_INTERPRETED_EXTENSIONS.some((extension) => lowerCased.endsWith(extension))) {
    return { shell: resolved, args: [...args] };
  }

  const comSpec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  return { shell: comSpec, args: ["/c", resolved, ...args] };
});

/**
 * Matches common CSI / OSC ANSI escape sequences emitted by interactive CLI
 * output. Shared by every PTY-backed usage probe.
 *
 * OSC bodies must not span ESC. A greedy `[^\x07]*` until the last `ESC \`
 * in the stream swallows later Ink frames — Cursor's `/usage` panel is
 * bookended by OSC-8 hyperlinks, which is how Auto/API rows disappeared
 * after a successful scrape.
 */
const ESCAPE_CHAR = String.fromCharCode(27);
const BEL_CHAR = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESCAPE_CHAR}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL_CHAR}${ESCAPE_CHAR}]*(?:${BEL_CHAR}|${ESCAPE_CHAR}\\\\))`,
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
  /**
   * When the surrounding Effect is interrupted, abort the probe immediately
   * instead of waiting out `timeoutMs` with an orphaned child process.
   */
  readonly signal?: AbortSignal;
  /**
   * Re-issues the probe command on a timer until the probe settles.
   *
   * Interactive CLIs routinely drop input written before they finish painting
   * the first frame and installing their key handlers. With a single write at
   * spawn time a dropped command is indistinguishable from "no usage data": the
   * probe waits out the full timeout and reports limits unavailable even for a
   * healthy, authenticated account. Slash commands like `/usage` just reopen a
   * panel, so re-issuing them is idempotent and safe.
   */
  readonly resend?: {
    readonly send: () => void;
    readonly everyMs: number;
    readonly maxAttempts: number;
  };
  readonly decideAfterOutput?: (rawOutput: string) => PtyProbeOutputDecision;
}): Promise<string> {
  return new Promise((resolve) => {
    let rawOutput = "";
    let settled = false;
    let exited = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let resendTimer: ReturnType<typeof setTimeout> | undefined;
    let resendAttempts = 0;
    let offData: () => void = () => {};
    let offExit: () => void = () => {};
    let offAbort: () => void = () => {};

    const clearSettleTimer = () => {
      if (settleTimer) {
        input.clock.clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    };

    const clearResendTimer = () => {
      if (resendTimer) {
        input.clock.clearTimeout(resendTimer);
        resendTimer = undefined;
      }
    };

    const scheduleResend = () => {
      const resend = input.resend;
      if (!resend || resendAttempts >= resend.maxAttempts) return;
      resendTimer = input.clock.setTimeout(() => {
        resendTimer = undefined;
        if (settled) return;
        resendAttempts += 1;
        try {
          resend.send();
        } catch {
          // A closed PTY surfaces on the exit listener; nothing to do here.
        }
        scheduleResend();
      }, resend.everyMs);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        input.clock.clearTimeout(timeout);
      }
      clearSettleTimer();
      clearResendTimer();
      offAbort();
      offData();
      offExit();
      // A probe whose binary is missing exits the instant it spawns, so this
      // path runs constantly for uninstalled providers. Never kill a PTY that
      // already exited — see `killPtyProcessQuietly`.
      if (!exited) {
        killPtyProcessQuietly(input.child);
      }
      resolve(rawOutput);
    };

    // Subscribe to exit before data/start so an already-exited child (the
    // adapter replays the last exit event) finishes immediately instead of
    // waiting out the probe timeout.
    offExit = input.child.onExit(() => {
      exited = true;
      finish();
    });
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
    timeout = input.clock.setTimeout(finish, input.timeoutMs);

    if (input.signal) {
      const onAbort = () => finish();
      if (input.signal.aborted) {
        finish();
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
      offAbort = () => input.signal?.removeEventListener("abort", onAbort);
    }

    if (settled) {
      return;
    }

    try {
      input.onStart?.();
    } catch {
      finish();
      return;
    }

    scheduleResend();
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
