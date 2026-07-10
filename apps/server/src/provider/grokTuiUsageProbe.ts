import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";

const GROK_USAGE_PROBE_TIMEOUT_MS = 10_000;
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

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

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, "");
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferYearForGrokReset(checkedAt: string, resetLine: string): number {
  const fromChecked = Number.parseInt(checkedAt.slice(0, 4), 10);
  if (Number.isFinite(fromChecked) && fromChecked >= 2000) {
    return fromChecked;
  }
  const match = resetLine.match(/\b(20\d{2})\b/);
  if (match) {
    return Number.parseInt(match[1]!, 10);
  }
  // checkedAt is always an ISO timestamp from DateTime.now in production.
  return 2000;
}

function parseGrokNextResetIso(checkedAt: string, resetLine: string): string | undefined {
  const trimmed = resetLine.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;

  const year = inferYearForGrokReset(checkedAt, trimmed);
  const withYear = /\b20\d{2}\b/.test(trimmed) ? trimmed : `${trimmed}, ${year}`;
  const pacificSuffix = /\b(?:pt|pdt|pst)\b/i.test(withYear)
    ? withYear.replace(/\b(?:pt|pdt|pst)\b/i, "GMT-0700")
    : withYear;

  const dt = DateTime.make(pacificSuffix);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
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

export interface ProbeClock {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
}

const defaultClock: ProbeClock = { setTimeout, clearTimeout };

function runGrokUsageProbeLoop(
  child: PtyAdapter.PtyProcess,
  input: GrokUsageProbeInput,
  clock: ProbeClock,
): Promise<GrokUsageProbeResult> {
  return new Promise((resolve) => {
    let rawOutput = "";
    let settled = false;

    const timeout = clock.setTimeout(() => {
      finish();
    }, GROK_USAGE_PROBE_TIMEOUT_MS);

    const finish = () => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timeout);
      offData();
      offExit();
      try {
        child.kill();
      } catch {
        // Ignore kill failures during cleanup.
      }
      resolve({
        usageLimits: parseGrokUsageLimitsOutput({
          output: rawOutput,
          checkedAt: input.checkedAt,
        }),
        rawOutput,
      });
    };

    const offData = child.onData((data) => {
      rawOutput += data;
      const parsed = parseGrokUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      });
      if (parsed.available) {
        finish();
      }
    });

    const offExit = child.onExit(() => {
      finish();
    });
  });
}

export function probeGrokUsageLimits(
  input: GrokUsageProbeInput,
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock: ProbeClock = defaultClock,
): Effect.Effect<GrokUsageProbeResult> {
  return Effect.gen(function* () {
    const child = yield* ptyAdapter
      .spawn({
        shell: input.binaryPath,
        args: ["/usage"],
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
