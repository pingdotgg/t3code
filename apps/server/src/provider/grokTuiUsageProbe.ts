import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  defaultProbeClock,
  killPtyProcessQuietly,
  type ProbeClock,
  rollResetYearForward,
  stripAnsi,
} from "./ptyProbeSupport.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";

export type { ProbeClock } from "./ptyProbeSupport.ts";

const GROK_USAGE_PROBE_TIMEOUT_MS = 10_000;
const GROK_USAGE_OUTPUT_SETTLE_MS = 200;

export interface GrokUsageProbeResult {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly rawOutput: string;
}

export interface GrokUsageProbeInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly checkedAt: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferYearForGrokReset(checkedAt: string): number {
  // checkedAt is always an ISO timestamp from DateTime.now in production.
  const fromChecked = Number.parseInt(checkedAt.slice(0, 4), 10);
  return Number.isFinite(fromChecked) && fromChecked >= 2000 ? fromChecked : 2000;
}

function parseGrokNextResetIso(checkedAt: string, resetLine: string): string | undefined {
  const trimmed = resetLine.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;

  const hasExplicitYear = /\b20\d{2}\b/.test(trimmed);
  const withYear = hasExplicitYear ? trimmed : `${trimmed}, ${inferYearForGrokReset(checkedAt)}`;
  const pacificTime = /\b(?:pt|pdt|pst)\b/i.test(withYear)
    ? withYear.replace(/\b(?:pt|pdt|pst)\b/i, "")
    : withYear;
  const dt = DateTime.makeZoned(pacificTime, {
    timeZone: "America/Los_Angeles",
    adjustForTimeZone: true,
  });
  return Option.isSome(dt)
    ? DateTime.formatIso(rollResetYearForward(dt.value, checkedAt, hasExplicitYear))
    : undefined;
}

export function parseGrokUsageLimitsOutput(input: {
  readonly output: string;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const cleaned = stripAnsi(input.output);
  const weeklyMatch = cleaned.match(/weekly\s*limit\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%/i);
  const usedPercent = parsePercent(weeklyMatch?.[1]);
  const resetMatch = cleaned.match(/next\s*reset\s*:\s*([^\n\r]+)/i);
  const resetsAt = resetMatch?.[1]
    ? parseGrokNextResetIso(input.checkedAt, resetMatch[1])
    : undefined;

  if (usedPercent !== undefined) {
    return makeUsageLimitsSnapshot({
      source: "grokStatusProbe",
      checkedAt: input.checkedAt,
      windows: [
        {
          label: "Weekly",
          usedPercent,
          windowDurationMins: 7 * 24 * 60,
          ...(resetsAt ? { resetsAt } : {}),
        },
      ],
      unavailableReason: "Usage limits unavailable for this Grok account.",
    });
  }

  return makeUnavailableUsageLimits({
    source: "grokStatusProbe",
    checkedAt: input.checkedAt,
    reason: "Usage limits unavailable for this Grok account.",
  });
}

function runGrokUsageProbeLoop(
  child: PtyAdapter.PtyProcess,
  input: GrokUsageProbeInput,
  clock: ProbeClock,
): Promise<GrokUsageProbeResult> {
  return new Promise((resolve) => {
    let rawOutput = "";
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = clock.setTimeout(() => {
      finish();
    }, GROK_USAGE_PROBE_TIMEOUT_MS);

    const finish = () => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timeout);
      if (settleTimer) {
        clock.clearTimeout(settleTimer);
      }
      offData();
      offExit();
      killPtyProcessQuietly(child);
      resolve({
        usageLimits: parseGrokUsageLimitsOutput({
          output: rawOutput,
          checkedAt: input.checkedAt,
        }),
        rawOutput,
      });
    };

    const scheduleFinishAfterUsageOutput = () => {
      if (settleTimer) {
        clock.clearTimeout(settleTimer);
      }
      settleTimer = clock.setTimeout(() => {
        finish();
      }, GROK_USAGE_OUTPUT_SETTLE_MS);
    };

    const offData = child.onData((data) => {
      rawOutput += data;
      const parsed = parseGrokUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      });
      if (parsed.available && parsed.windows.every((window) => window.resetsAt)) {
        finish();
      } else if (parsed.available) {
        scheduleFinishAfterUsageOutput();
      }
    });

    const offExit = child.onExit(() => {
      finish();
    });

    child.write("/usage\r");
  });
}

export function probeGrokUsageLimits(
  input: GrokUsageProbeInput,
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock: ProbeClock = defaultProbeClock,
): Effect.Effect<GrokUsageProbeResult> {
  return Effect.gen(function* () {
    const child = yield* ptyAdapter
      .spawn({
        shell: input.binaryPath,
        args: [],
        cwd: input.cwd,
        cols: 120,
        rows: 40,
        env: input.environment ?? process.env,
      })
      .pipe(Effect.orElseSucceed(() => null as PtyAdapter.PtyProcess | null));

    if (!child) {
      return {
        usageLimits: makeUnavailableUsageLimits({
          source: "grokStatusProbe",
          checkedAt: input.checkedAt,
          reason: "Failed to spawn Grok process for usage probe.",
        }),
        rawOutput: "",
      };
    }

    return yield* Effect.promise(() => runGrokUsageProbeLoop(child, input, clock));
  });
}
