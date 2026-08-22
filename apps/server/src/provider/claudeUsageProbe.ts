import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";
import {
  collectPtyProbeOutput,
  defaultProbeClock,
  type ProbeClock,
  resolvePtyProbeCommand,
  rollResetYearForward,
  stripAnsi,
} from "./ptyProbeSupport.ts";

export type { ProbeClock } from "./ptyProbeSupport.ts";

/**
 * `claude --print /usage` performs a real API round trip: measured at ~2.7s
 * warm and ~8s cold on a subscription account. The previous 4s budget expired
 * before the CLI answered on anything but a warm cache, so the probe reported
 * "Could not read usage limits" for accounts that were working fine. Keep this
 * above the cold-start cost while staying in the same range as the other
 * provider probes.
 */
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 15_000;

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

function extractClaudeUsageText(value: string): string {
  const cleaned = stripAnsi(value).trim();
  try {
    const result = readObjectRecord(JSON.parse(cleaned))?.result;
    return typeof result === "string" ? result : cleaned;
  } catch {
    return cleaned;
  }
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferWindowDurationMins(value: string): number | undefined {
  const lower = value.toLowerCase();
  if (/\bweek(?:ly)?\b|\b7[\s-]*(?:day|days)\b/.test(lower)) {
    return 7 * 24 * 60;
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return 5 * 60;
  }
  return undefined;
}

function detectClaudeUsageWindowKind(value: string): "session" | "weekly" | undefined {
  const lower = value.toLowerCase().trim();
  // Print-mode appends a contributing-stats block ("Last 7d · N requests",
  // "73% of your usage was at >150k context"). That is not a quota window.
  if (/^last\s+\d/.test(lower)) {
    return undefined;
  }
  if (/\bcurrent week\b|\bweek(?:ly)?(?:\s+usage)?\b|\b7[\s-]*(?:day|days)\b/.test(lower)) {
    return "weekly";
  }
  if (
    /\bcurrent session\b|\bsession usage\b|\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)
  ) {
    return "session";
  }
  return undefined;
}

/** Matches a parenthesized IANA zone id, e.g. "(Asia/Kolkata)" or "(America/Los_Angeles)". */
const IANA_TIMEZONE_PATTERN = /\(([^()\s]+\/[^()\s]+)\)\s*$/;
const MONTH_ABBREVIATIONS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function monthNumberFromName(name: string): number | undefined {
  const index = MONTH_ABBREVIATIONS.indexOf(
    name.slice(0, 3).toLowerCase() as (typeof MONTH_ABBREVIATIONS)[number],
  );
  return index === -1 ? undefined : index + 1;
}

/**
 * `DateTime.make`/`DateTime.makeZoned` only understand 24-hour clock strings,
 * but Claude's print-mode output uses "Mon D[, YYYY], h:mmam/pm". Build a
 * `YYYY-MM-DD HH:mm:00` string DateTime can parse unambiguously.
 */
function toCanonicalLocalDateTime(text: string, year: number): string | undefined {
  const match = text.match(
    /([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(?:(?:19|20)\d{2},?\s*)?(\d{1,2}):(\d{2})\s*(am|pm)?/i,
  );
  if (!match) return undefined;
  const [, monthName, dayText, hourText, minute, meridiem] = match;
  const month = monthName ? monthNumberFromName(monthName) : undefined;
  const day = Number.parseInt(dayText ?? "", 10);
  let hour = Number.parseInt(hourText ?? "", 10);
  if (!month || !Number.isFinite(day) || !Number.isFinite(hour)) {
    return undefined;
  }
  if (meridiem) {
    const isPm = meridiem.toLowerCase() === "pm";
    if (hour === 12) hour = isPm ? 12 : 0;
    else if (isPm) hour += 12;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(
    hour,
  ).padStart(2, "0")}:${minute}:00`;
}

function hostTimeZoneId(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return zone && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}

function parseCanonicalReset(
  text: string,
  checkedAt: string,
  timeZone: string | undefined,
): string | undefined {
  const hasExplicitYear = /\b(?:19|20)\d{2}\b/.test(text);
  const year = hasExplicitYear
    ? Number.parseInt(text.match(/\b((?:19|20)\d{2})\b/)![1]!, 10)
    : Number.parseInt(checkedAt.slice(0, 4), 10);
  const canonical = Number.isFinite(year) ? toCanonicalLocalDateTime(text, year) : undefined;
  if (!canonical) return undefined;
  if (timeZone) {
    const zoned = DateTime.makeZoned(canonical, { timeZone, adjustForTimeZone: true });
    return Option.isSome(zoned)
      ? DateTime.formatIso(rollResetYearForward(zoned.value, checkedAt, hasExplicitYear))
      : undefined;
  }
  const utc = DateTime.make(canonical);
  return Option.isSome(utc)
    ? DateTime.formatIso(rollResetYearForward(utc.value, checkedAt, hasExplicitYear))
    : undefined;
}

function extractResetTimestamp(value: string, checkedAt: string): string | undefined {
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

  const ianaZoneMatch = candidate.match(IANA_TIMEZONE_PATTERN);
  const ianaZoneId = ianaZoneMatch?.[1];
  if (ianaZoneMatch?.index !== undefined && ianaZoneId) {
    return parseCanonicalReset(
      candidate.slice(0, ianaZoneMatch.index).trim(),
      checkedAt,
      ianaZoneId,
    );
  }

  const hasExplicitOffset =
    /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z\b|[+-]\d{2}:?\d{2}|\b(?:utc|gmt|p[sd]t|m[sd]t|c[sd]t|e[sd]t)\b/i.test(
      candidate,
    );
  if (hasExplicitOffset) {
    const dt = DateTime.make(candidate);
    return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
  }

  // Current print-mode still uses "Mon D, h:mmapm" and sometimes drops the
  // parenthesized IANA zone. That wall clock is local to the machine running
  // the probe.
  return parseCanonicalReset(candidate, checkedAt, hostTimeZoneId());
}

function parseClaudeUsageWindowSegment(
  kind: "session" | "weekly",
  segment: string,
  checkedAt: string,
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
  const resetsAt = extractResetTimestamp(segment, checkedAt);

  return {
    label: kind === "session" ? "Session" : "Weekly",
    usedPercent,
    windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function extractWindowSegments(
  output: string,
  checkedAt: string,
): ReadonlyArray<{
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
    const parsed = parseClaudeUsageWindowSegment(kind, segment, checkedAt);
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
  const cleanedOutput = extractClaudeUsageText(input.output);
  const lowerOutput = cleanedOutput.toLowerCase();
  const windows = extractWindowSegments(cleanedOutput, input.checkedAt);

  if (windows.length > 0) {
    return makeUsageLimitsSnapshot({
      source: "claudeStatusProbe",
      checkedAt: input.checkedAt,
      windows,
      unavailableReason: "Could not read usage limits for this Claude account.",
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
    reason: "Could not read usage limits for this Claude account.",
  });
}

function runProbeLoop(
  child: PtyAdapter.PtyProcess,
  input: ClaudeUsageProbeInput,
  clock: ProbeClock,
): Promise<ClaudeUsageProbeResult> {
  return collectPtyProbeOutput({
    child,
    clock,
    timeoutMs: CLAUDE_USAGE_PROBE_TIMEOUT_MS,
  }).then((rawOutput) => {
    return {
      usageLimits: parseClaudeUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      }),
      rawOutput,
    };
  });
}

export function probeClaudeUsageLimits(
  input: ClaudeUsageProbeInput,
  clock: ProbeClock = defaultProbeClock,
): Effect.Effect<ClaudeUsageProbeResult> {
  const probeArgs = [
    ...tokenizeCliArgs(input.launchArgs),
    "--print",
    "/usage",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
  ];

  return Effect.gen(function* () {
    const ptyAdapter = Option.getOrUndefined(yield* Effect.serviceOption(PtyAdapter.PtyAdapter));
    if (!ptyAdapter) {
      return {
        usageLimits: makeUnavailableUsageLimits({
          source: "claudeStatusProbe",
          checkedAt: input.checkedAt,
          reason: "Usage limits are unavailable in this runtime.",
        }),
        rawOutput: "",
      };
    }

    const environment = input.environment ?? process.env;
    const command = yield* resolvePtyProbeCommand(input.binaryPath, probeArgs, environment);
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
