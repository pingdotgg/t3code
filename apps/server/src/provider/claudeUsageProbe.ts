import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";
import {
  defaultProbeClock,
  killPtyProcessQuietly,
  type ProbeClock,
  rollResetYearForward,
  stripAnsi,
} from "./ptyProbeSupport.ts";

export type { ProbeClock } from "./ptyProbeSupport.ts";

const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 4_000;

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
  if (/\bweek(?:ly)?\b|\b7\s*(?:d|day|days)\b/.test(lower)) {
    return 7 * 24 * 60;
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return 5 * 60;
  }
  return undefined;
}

function detectClaudeUsageWindowKind(value: string): "session" | "weekly" | undefined {
  const lower = value.toLowerCase();
  if (/\bweek(?:ly)?\b|\b7\s*(?:d|day|days)\b/.test(lower)) {
    return "weekly";
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return "session";
  }
  return undefined;
}

/** Matches a parenthesized IANA zone id, e.g. "(Asia/Kolkata)" or "(America/Los_Angeles)". */
const IANA_TIMEZONE_PATTERN = /\(([A-Za-z]+(?:\/[A-Za-z_]+){1,2})\)/;
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
  const match = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
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
    const withoutZone = candidate.slice(0, ianaZoneMatch.index).trim();
    const hasExplicitYear = /\b(?:19|20)\d{2}\b/.test(withoutZone);
    const year = hasExplicitYear
      ? Number.parseInt(withoutZone.match(/\b((?:19|20)\d{2})\b/)![1]!, 10)
      : Number.parseInt(checkedAt.slice(0, 4), 10);
    const canonical = Number.isFinite(year)
      ? toCanonicalLocalDateTime(withoutZone, year)
      : undefined;
    if (!canonical) return undefined;
    const dt = DateTime.makeZoned(canonical, { timeZone: ianaZoneId, adjustForTimeZone: true });
    return Option.isSome(dt)
      ? DateTime.formatIso(rollResetYearForward(dt.value, checkedAt, hasExplicitYear))
      : undefined;
  }

  const hasExplicitOffset =
    /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z\b|[+-]\d{2}:?\d{2}|\b(?:utc|gmt|p[sd]t|m[sd]t|c[sd]t|e[sd]t)\b/i.test(
      candidate,
    );
  if (!hasExplicitOffset) {
    return undefined;
  }
  const dt = DateTime.make(candidate);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
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
    const timeout = clock.setTimeout(finish, CLAUDE_USAGE_PROBE_TIMEOUT_MS);

    function finish() {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timeout);
      offData();
      offExit();
      killPtyProcessQuietly(child);
      resolve({
        usageLimits: parseClaudeUsageLimitsOutput({
          output: rawOutput,
          checkedAt: input.checkedAt,
        }),
        rawOutput,
      });
    }

    const offData = child.onData((data) => {
      rawOutput += data;
    });
    const offExit = child.onExit(finish);
  });
}

export function probeClaudeUsageLimits(
  input: ClaudeUsageProbeInput,
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock: ProbeClock = defaultProbeClock,
): Effect.Effect<ClaudeUsageProbeResult> {
  const probeArgs = [
    ...splitLaunchArgs(input.launchArgs),
    "--print",
    "/usage",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
  ];

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
