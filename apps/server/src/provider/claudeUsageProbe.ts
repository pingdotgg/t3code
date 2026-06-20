import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";

const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 4_000;
const CLAUDE_USAGE_FALLBACK_IDLE_MS = 150;
const ANSI_PATTERN =
  // Matches common CSI / OSC ANSI escape sequences.
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export interface ClaudeUsageProbeResult {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly rawOutput: string;
}

export interface ClaudeUsageProbeInput {
  readonly binaryPath: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly checkedAt: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function readObjectRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRateLimitDurationMins(value: unknown): number | undefined {
  switch (value) {
    case "five_hour":
      return 5 * 60;
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
      return 7 * 24 * 60;
    default:
      return undefined;
  }
}

function toRateLimitResetTimestamp(value: unknown): string | undefined {
  const timestampSeconds = readNumber(value);
  if (timestampSeconds === undefined) {
    return undefined;
  }

  return DateTime.formatIso(DateTime.makeUnsafe(timestampSeconds * 1000));
}

export function parseClaudeRuntimeUsageLimits(input: {
  readonly checkedAt: string;
  readonly rateLimits: unknown;
}): ServerProviderUsageLimits | undefined {
  const eventRecord = readObjectRecord(input.rateLimits);
  const rateLimitInfo =
    readObjectRecord(eventRecord?.rate_limit_info) ?? readObjectRecord(input.rateLimits);
  if (!rateLimitInfo) {
    return undefined;
  }

  const usedPercent = readNumber(rateLimitInfo.utilization);
  const windowDurationMins = readRateLimitDurationMins(rateLimitInfo.rateLimitType);
  if (usedPercent === undefined || windowDurationMins === undefined) {
    return undefined;
  }

  const resetsAt = toRateLimitResetTimestamp(rateLimitInfo.resetsAt);

  return makeUsageLimitsSnapshot({
    source: "claudeStatusProbe",
    checkedAt: input.checkedAt,
    windows: [
      {
        label: windowDurationMins === 5 * 60 ? "Session" : "Weekly",
        usedPercent,
        windowDurationMins,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ],
    unavailableReason: "Usage limits unavailable for this Claude account.",
  });
}

export function shouldRequestClaudeUsageFallback(input: {
  readonly output: string;
  readonly checkedAt: string;
  readonly fallbackAlreadySent?: boolean;
}): boolean {
  if (input.fallbackAlreadySent) {
    return false;
  }

  const parsed = parseClaudeUsageLimitsOutput(input);
  return !parsed.available;
}

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, "");
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferWindowDurationMins(value: string): number | undefined {
  const lower = value.toLowerCase();
  if (/\bweekly\b|\b7\s*(?:d|day|days)\b/.test(lower)) {
    return 7 * 24 * 60;
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return 5 * 60;
  }
  return undefined;
}

function detectClaudeUsageWindowKind(value: string): "session" | "weekly" | undefined {
  const lower = value.toLowerCase();
  if (/\bweekly\b|\b7\s*(?:d|day|days)\b/.test(lower)) {
    return "weekly";
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return "session";
  }
  return undefined;
}

function extractResetTimestamp(value: string): string | undefined {
  const resetMatch = value.match(/\breset(?:s|ting)?(?:\s+(?:at|on|in))?[:\s-]*([^\n.;]+)/i);
  const rawCandidate = resetMatch?.[1]
    ?.trim()
    .replace(/\s+/g, " ")
    .replace(/\b(?:local time|your time|time)\b.*$/i, "")
    .trim();
  const isoCandidate = rawCandidate?.match(
    /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})\b/i,
  )?.[0];
  const candidate = isoCandidate ?? rawCandidate;
  if (!candidate) return undefined;
  if (/\b(?:today|tomorrow|tonight|next)\b/i.test(candidate)) {
    return undefined;
  }
  const hasExplicitTimezone =
    /(?:z|[+-]\d{2}:?\d{2}|\b(?:utc|gmt|p[sd]t|m[sd]t|c[sd]t|e[sd]t)\b)/i.test(candidate);
  if (!hasExplicitTimezone) {
    return undefined;
  }
  const dt = DateTime.make(candidate);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function parseClaudeUsageWindowSegment(
  kind: "session" | "weekly",
  segment: string,
): {
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt?: string;
} | null {
  const percentMatch = segment.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const usedPercent = parsePercent(percentMatch?.[1]);
  const windowDurationMins = inferWindowDurationMins(segment);
  if (usedPercent === undefined || windowDurationMins === undefined) {
    return null;
  }
  const resetsAt = extractResetTimestamp(segment);

  return {
    label: kind === "session" ? "Session" : "Weekly",
    usedPercent,
    windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function extractWindowSegments(output: string): ReadonlyArray<{
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt?: string;
}> {
  const lines = output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const windows = new Map<"session" | "weekly", (typeof lines)[number]>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const kind = detectClaudeUsageWindowKind(line);
    if (!kind || windows.has(kind)) continue;

    const segmentLines = [line];
    for (let cursor = index + 1; cursor < lines.length && segmentLines.length < 3; cursor += 1) {
      const candidate = lines[cursor]!;
      if (detectClaudeUsageWindowKind(candidate)) {
        break;
      }
      segmentLines.push(candidate);
    }
    const neighborhood = segmentLines.join(" ");
    windows.set(kind, neighborhood);
  }

  return [...windows.entries()].flatMap(([kind, segment]) => {
    const parsed = parseClaudeUsageWindowSegment(kind, segment);
    if (!parsed) {
      return [];
    }

    return [parsed];
  });
}

export function parseClaudeUsageLimitsOutput(input: {
  readonly output: string;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const cleanedOutput = stripAnsi(input.output);
  const lowerOutput = cleanedOutput.toLowerCase();
  const windows = extractWindowSegments(cleanedOutput);

  if (windows.length > 0) {
    return makeUsageLimitsSnapshot({
      source: "claudeStatusProbe",
      checkedAt: input.checkedAt,
      windows,
      unavailableReason: "Usage limits unavailable for this Claude account.",
    });
  }

  if (/\busing api key\b|\busing.an api.key\b/.test(lowerOutput)) {
    return makeUnavailableUsageLimits({
      source: "claudeStatusProbe",
      checkedAt: input.checkedAt,
      reason: "Usage limits unavailable for Claude API key accounts.",
    });
  }

  return makeUnavailableUsageLimits({
    source: "claudeStatusProbe",
    checkedAt: input.checkedAt,
    reason: "Usage limits unavailable for this Claude account.",
  });
}

export interface ProbeClock {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
}

const defaultClock: ProbeClock = { setTimeout, clearTimeout };

function splitLaunchArgs(launchArgs?: string): string[] {
  if (!launchArgs?.trim()) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (const character of launchArgs) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  pushCurrent();
  return tokens;
}

function runProbeLoop(
  child: PtyAdapter.PtyProcess,
  input: ClaudeUsageProbeInput,
  clock: ProbeClock,
): Promise<ClaudeUsageProbeResult> {
  return new Promise((resolve) => {
    let rawOutput = "";
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let sentFallback = false;

    const timeout = clock.setTimeout(() => {
      finish();
    }, CLAUDE_USAGE_PROBE_TIMEOUT_MS);

    const scheduleFallback = () => {
      if (sentFallback || settled) {
        return;
      }
      if (fallbackTimer) {
        clock.clearTimeout(fallbackTimer);
      }
      fallbackTimer = clock.setTimeout(() => {
        fallbackTimer = undefined;
        maybeRequestFallback();
      }, CLAUDE_USAGE_FALLBACK_IDLE_MS);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timeout);
      if (fallbackTimer) {
        clock.clearTimeout(fallbackTimer);
      }
      offData();
      offExit();
      try {
        child.kill();
      } catch {
        // Ignore kill failures during cleanup.
      }
      resolve({
        usageLimits: parseClaudeUsageLimitsOutput({
          output: rawOutput,
          checkedAt: input.checkedAt,
        }),
        rawOutput,
      });
    };

    const maybeRequestFallback = () => {
      if (sentFallback) return;
      if (
        !shouldRequestClaudeUsageFallback({
          output: rawOutput,
          checkedAt: input.checkedAt,
          fallbackAlreadySent: sentFallback,
        })
      ) {
        finish();
        return;
      }
      sentFallback = true;
      child.write("/usage\r");
    };

    const offData = child.onData((data) => {
      rawOutput += data;
      const parsed = parseClaudeUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      });
      if (parsed.available) {
        finish();
        return;
      }
      if (!sentFallback) {
        scheduleFallback();
      }
    });

    const offExit = child.onExit(() => {
      finish();
    });

    child.write("/status\r");
    scheduleFallback();
  });
}

export function probeClaudeUsageLimits(
  input: ClaudeUsageProbeInput,
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock: ProbeClock = defaultClock,
): Effect.Effect<ClaudeUsageProbeResult> {
  const probeArgs = [...splitLaunchArgs(input.launchArgs), "--permission-mode", "plan"];

  return Effect.gen(function* () {
    const child = yield* ptyAdapter
      .spawn({
        shell: input.binaryPath,
        args: probeArgs,
        cwd: input.cwd,
        cols: 120,
        rows: 40,
        env: input.environment ?? process.env,
      })
      .pipe(Effect.orElseSucceed(() => null as PtyAdapter.PtyProcess | null));

    if (!child) {
      return {
        usageLimits: makeUnavailableUsageLimits({
          source: "claudeStatusProbe",
          checkedAt: input.checkedAt,
          reason: "Failed to spawn Claude process for usage probe.",
        }),
        rawOutput: "",
      };
    }

    return yield* Effect.promise(() => runProbeLoop(child, input, clock));
  });
}
