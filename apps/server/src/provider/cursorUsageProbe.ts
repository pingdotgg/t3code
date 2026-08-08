import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  collectPtyProbeOutput,
  defaultProbeClock,
  type ProbeClock,
  rollResetYearForward,
  stripAnsi,
} from "./ptyProbeSupport.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";

export type { ProbeClock } from "./ptyProbeSupport.ts";

const CURSOR_USAGE_PROBE_TIMEOUT_MS = 10_000;
const CURSOR_USAGE_OUTPUT_SETTLE_MS = 200;
/** Cursor's `/usage` window resets on a monthly cadence, not a fixed weekly one. */
const CURSOR_INCLUDED_WINDOW_DURATION_MINS = 30 * 24 * 60;

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
  const match = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+((?:19|20)\d{2}))?$/);
  if (!match) return undefined;
  const [, day, month, explicitYear] = match;
  const hasExplicitYear = Boolean(explicitYear);
  const year = explicitYear ?? String(inferYearForCursorReset(checkedAt));
  const canonical = `${month} ${day}, ${year}`;
  const dt = DateTime.makeZoned(canonical, { timeZone: "UTC", adjustForTimeZone: true });
  return Option.isSome(dt)
    ? DateTime.formatIso(rollResetYearForward(dt.value, checkedAt, hasExplicitYear))
    : undefined;
}

export function parseCursorUsageLimitsOutput(input: {
  readonly output: string;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const cleaned = stripAnsi(input.output);
  const includedMatch = cleaned.match(/^\s*Included\s+(\d{1,3}(?:\.\d+)?)\s*%\s*used/im);
  const usedPercent = parsePercent(includedMatch?.[1]);
  const resetMatch = cleaned.match(/\bResets\s+(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+(?:19|20)\d{2})?)\b/);
  const resetsAt = resetMatch?.[1]
    ? parseCursorResetsAtIso(input.checkedAt, resetMatch[1])
    : undefined;

  if (usedPercent !== undefined) {
    return makeUsageLimitsSnapshot({
      source: "cursorStatusProbe",
      checkedAt: input.checkedAt,
      windows: [
        {
          label: "Included",
          usedPercent,
          windowDurationMins: CURSOR_INCLUDED_WINDOW_DURATION_MINS,
          ...(resetsAt ? { resetsAt } : {}),
        },
      ],
      unavailableReason: "Could not read usage limits for this Cursor account.",
    });
  }

  return makeUnavailableUsageLimits({
    source: "cursorStatusProbe",
    checkedAt: input.checkedAt,
    reason: "Could not read usage limits for this Cursor account.",
  });
}

function runCursorUsageProbeLoop(
  child: PtyAdapter.PtyProcess,
  input: CursorUsageProbeInput,
  clock: ProbeClock,
): Promise<CursorUsageProbeResult> {
  return collectPtyProbeOutput({
    child,
    clock,
    timeoutMs: CURSOR_USAGE_PROBE_TIMEOUT_MS,
    onStart: () => child.write("/usage\r"),
    decideAfterOutput: (rawOutput) => {
      const parsed = parseCursorUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      });
      if (parsed.available && parsed.windows.every((window) => window.resetsAt)) {
        return "finish";
      }
      return parsed.available ? { settleAfterMs: CURSOR_USAGE_OUTPUT_SETTLE_MS } : "continue";
    },
  }).then((rawOutput) => {
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
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock: ProbeClock = defaultProbeClock,
): Effect.Effect<CursorUsageProbeResult> {
  return Effect.gen(function* () {
    const child = yield* ptyAdapter
      .spawn({
        shell: input.binaryPath,
        args: input.apiEndpoint ? ["-e", input.apiEndpoint] : [],
        cwd: input.cwd,
        cols: 120,
        rows: 40,
        env: input.environment ?? process.env,
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
