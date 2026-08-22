import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  collectPtyProbeOutput,
  defaultProbeClock,
  type ProbeClock,
  resolvePtyProbeCommand,
  rollResetYearForward,
  stripAnsi,
} from "./ptyProbeSupport.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";

export type { ProbeClock } from "./ptyProbeSupport.ts";

const CURSOR_USAGE_PROBE_TIMEOUT_MS = 25_000;
/**
 * `/usage` is a slash command that is only registered after the TUI finishes
 * booting and the dashboard client is up. Typing it during the splash screen
 * opens the command palette with "No matches" and never paints the usage
 * pager. Wait for the composer, give the dashboard a beat to register the
 * command, then confirm the highlighted `/usage` match with Enter. A second
 * Escape retry is only for a palette miss — confirming a hit with Enter is
 * what actually opens Auto/API.
 *
 * Retries are scheduled from the send itself: if `/usage` is swallowed with
 * no further paint, waiting for the next `onData` would sit until timeout.
 */
const CURSOR_USAGE_COMMAND_READY_DELAY_MS = 800;
const CURSOR_USAGE_COMMAND_RETRY_MS = 1_500;
const CURSOR_USAGE_COMMAND_MAX_ATTEMPTS = 4;
/** Cursor's `/usage` window resets on a monthly cadence, not a fixed weekly one. */
const CURSOR_MONTHLY_WINDOW_DURATION_MINS = 30 * 24 * 60;
const CURSOR_USAGE_ROW_LABELS = ["Auto", "API"] as const;

function isCursorUsageRowLabel(value: string): value is (typeof CURSOR_USAGE_ROW_LABELS)[number] {
  return (CURSOR_USAGE_ROW_LABELS as readonly string[]).includes(value);
}

export interface CursorUsageProbeResult {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly rawOutput: string;
}

export interface CursorUsageProbeInput {
  readonly binaryPath: string;
  readonly apiEndpoint?: string;
  readonly cwd: string;
  readonly checkedAt: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferYearForCursorReset(checkedAt: string): number {
  // checkedAt is always an ISO timestamp from DateTime.now in production.
  const fromChecked = Number.parseInt(checkedAt.slice(0, 4), 10);
  return Number.isFinite(fromChecked) && fromChecked >= 2000 ? fromChecked : 2000;
}

/**
 * Cursor's `/usage` panel reports resets as "D Mon" (e.g. "7 Aug") with no
 * year or time-of-day. Reorder to a "Mon D, YYYY" string DateTime can parse,
 * assuming UTC since the panel gives no timezone.
 */
function parseCursorResetsAtIso(checkedAt: string, resetText: string): string | undefined {
  const trimmed = resetText.trim().replace(/\s+/g, " ");
  const match = trimmed.match(
    /^(?:(\d{1,2})\s+([A-Za-z]{3,9})|([A-Za-z]{3,9})\s+(\d{1,2}))(?:\s+((?:19|20)\d{2}))?$/,
  );
  if (!match) return undefined;
  const day = match[1] ?? match[4];
  const month = match[2] ?? match[3];
  const explicitYear = match[5];
  if (!day || !month) return undefined;
  const hasExplicitYear = Boolean(explicitYear);
  const year = explicitYear ?? String(inferYearForCursorReset(checkedAt));
  // `/usage` writes "Sept"; DateTime wants a 3-letter English month.
  const canonical = `${month.slice(0, 3)} ${day}, ${year}`;
  const dt = DateTime.makeZoned(canonical, { timeZone: "UTC", adjustForTimeZone: true });
  return Option.isSome(dt)
    ? DateTime.formatIso(rollResetYearForward(dt.value, checkedAt, hasExplicitYear))
    : undefined;
}

function parseCursorUsageRows(cleaned: string): ReadonlyArray<{
  readonly label: (typeof CURSOR_USAGE_ROW_LABELS)[number];
  readonly usedPercent: number;
}> {
  const rows = new Map<(typeof CURSOR_USAGE_ROW_LABELS)[number], number>();
  // Ink may emit `Auto  2% used` or the compact `Auto: 2% used`, and
  // cursor addressing often leaves no line start in front of the label.
  const pattern = /\b(Auto|API)\s*:?\s*(\d{1,3}(?:\.\d+)?)\s*%/gi;
  for (const match of cleaned.matchAll(pattern)) {
    const label = match[1];
    const usedPercent = parsePercent(match[2]);
    if (!label || !isCursorUsageRowLabel(label) || usedPercent === undefined || rows.has(label)) {
      continue;
    }
    rows.set(label, usedPercent);
  }
  return CURSOR_USAGE_ROW_LABELS.flatMap((label) => {
    const usedPercent = rows.get(label);
    return usedPercent === undefined ? [] : [{ label, usedPercent }];
  });
}

export function parseCursorUsageLimitsOutput(input: {
  readonly output: string;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const cleaned = stripAnsi(input.output);
  const rows = parseCursorUsageRows(cleaned);
  // Ink right-aligns the reset with CUF (`ESC [ n C`), so after stripping
  // ANSI the header is often `Usage • ProResets 16 Sept` with no word break.
  const resetMatch = cleaned.match(
    /Resets\s+(?:(\d{1,2}\s+[A-Za-z]{3,9})|([A-Za-z]{3,9}\s+\d{1,2}))(?:\s+((?:19|20)\d{2}))?\b/,
  );
  const resetText = [resetMatch?.[1] ?? resetMatch?.[2], resetMatch?.[3]].filter(Boolean).join(" ");
  const resetsAt = resetText ? parseCursorResetsAtIso(input.checkedAt, resetText) : undefined;

  if (rows.length > 0) {
    return makeUsageLimitsSnapshot({
      source: "cursorStatusProbe",
      checkedAt: input.checkedAt,
      windows: rows.map((row) => ({
        label: row.label,
        usedPercent: row.usedPercent,
        windowDurationMins: CURSOR_MONTHLY_WINDOW_DURATION_MINS,
        ...(resetsAt ? { resetsAt } : {}),
      })),
      unavailableReason: "Could not read usage limits for this Cursor account.",
    });
  }

  return makeUnavailableUsageLimits({
    source: "cursorStatusProbe",
    checkedAt: input.checkedAt,
    reason: "Could not read usage limits for this Cursor account.",
  });
}

function isCursorUsageTableComplete(parsed: ServerProviderUsageLimits): boolean {
  const labels = new Set(parsed.windows.map((window) => window.label));
  return labels.has("Auto") && labels.has("API");
}

function isCursorComposerReady(output: string): boolean {
  const cleaned = stripAnsi(output);
  // Wide PTYs (this probe is 120 cols) use "Run a command — e.g., dir" on
  // Windows instead of the empty-chat "Plan, search, build anything" copy.
  return (
    /Plan, search, build anything/i.test(cleaned) ||
    /Add a follow-up/i.test(cleaned) ||
    /Run a command/i.test(cleaned) ||
    /Tip: Use \/debug/i.test(cleaned)
  );
}

function isCursorUsagePaletteReady(output: string): boolean {
  const cleaned = stripAnsi(output);
  return /Show plan and on-demand usage/i.test(cleaned);
}

function runCursorUsageProbeLoop(
  child: PtyAdapter.PtyProcess,
  input: CursorUsageProbeInput,
  clock: ProbeClock,
): Promise<CursorUsageProbeResult> {
  let usageAttempts = 0;
  let acceptedUsage = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer === undefined) {
      return undefined;
    }
    clock.clearTimeout(timer);
    return undefined;
  };

  const clearSendTimers = () => {
    readyTimer = clearTimer(readyTimer);
    retryTimer = clearTimer(retryTimer);
  };

  const sendUsage = () => {
    if (usageAttempts >= CURSOR_USAGE_COMMAND_MAX_ATTEMPTS) {
      return;
    }
    if (usageAttempts > 0) {
      child.write("\x1b");
    }
    usageAttempts += 1;
    acceptedUsage = false;
    child.write("/usage\r");
    retryTimer = clearTimer(retryTimer);
    if (usageAttempts < CURSOR_USAGE_COMMAND_MAX_ATTEMPTS) {
      retryTimer = clock.setTimeout(() => {
        retryTimer = undefined;
        sendUsage();
      }, CURSOR_USAGE_COMMAND_RETRY_MS);
    }
  };

  const acceptUsage = () => {
    if (acceptedUsage) {
      return;
    }
    acceptedUsage = true;
    retryTimer = clearTimer(retryTimer);
    child.write("\r");
  };

  return collectPtyProbeOutput({
    child,
    clock,
    timeoutMs: CURSOR_USAGE_PROBE_TIMEOUT_MS,
    decideAfterOutput: (rawOutput) => {
      const parsed = parseCursorUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      });
      const loading = /Loading usage data/i.test(stripAnsi(rawOutput));
      if (parsed.available && isCursorUsageTableComplete(parsed)) {
        clearSendTimers();
        return "finish";
      }
      if (loading) {
        clearSendTimers();
        return "continue";
      }

      if (usageAttempts > 0 && isCursorUsagePaletteReady(rawOutput)) {
        acceptUsage();
        return "continue";
      }

      if (usageAttempts === 0 && readyTimer === undefined && isCursorComposerReady(rawOutput)) {
        readyTimer = clock.setTimeout(() => {
          readyTimer = undefined;
          sendUsage();
        }, CURSOR_USAGE_COMMAND_READY_DELAY_MS);
      }

      return "continue";
    },
  }).then((rawOutput) => {
    clearSendTimers();
    return {
      usageLimits: parseCursorUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      }),
      rawOutput,
    };
  });
}

export function probeCursorUsageLimits(
  input: CursorUsageProbeInput,
  clock: ProbeClock = defaultProbeClock,
): Effect.Effect<CursorUsageProbeResult> {
  return Effect.gen(function* () {
    const ptyAdapter = Option.getOrUndefined(yield* Effect.serviceOption(PtyAdapter.PtyAdapter));
    if (!ptyAdapter) {
      return {
        usageLimits: makeUnavailableUsageLimits({
          source: "cursorStatusProbe",
          checkedAt: input.checkedAt,
          reason: "Usage limits are unavailable in this runtime.",
        }),
        rawOutput: "",
      };
    }

    const environment: NodeJS.ProcessEnv = {
      ...(input.environment ?? process.env),
      FORCE_COLOR: "1",
    };
    delete environment.CI;
    const command = yield* resolvePtyProbeCommand(
      input.binaryPath,
      ["--trust", ...(input.apiEndpoint ? ["-e", input.apiEndpoint] : [])],
      environment,
    );
    const child = yield* ptyAdapter
      .spawn({
        shell: command.shell,
        args: command.args,
        cwd: input.cwd,
        cols: 120,
        rows: 40,
        env: environment,
      })
      .pipe(Effect.orElseSucceed(() => null as PtyAdapter.PtyProcess | null));

    if (!child) {
      return {
        usageLimits: makeUnavailableUsageLimits({
          source: "cursorStatusProbe",
          checkedAt: input.checkedAt,
          reason: "Failed to spawn Cursor process for usage probe.",
        }),
        rawOutput: "",
      };
    }

    return yield* Effect.promise(() => runCursorUsageProbeLoop(child, input, clock));
  });
}
