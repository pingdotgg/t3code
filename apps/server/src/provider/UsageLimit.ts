import { type RuntimeUsageLimitDetail } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const USAGE_LIMIT_MESSAGE_PATTERN =
  /\b(?:usage\s+limit|usageLimitExceeded|workspace_(?:owner|member)_usage_limit_reached)\b/iu;
const CLAUDE_USAGE_LIMIT_PATTERN = /\bClaude\s+AI\s+usage\s+limit\s+reached\b/iu;
const CLAUDE_USAGE_LIMIT_WITH_RESET_PATTERN =
  /\bClaude\s+AI\s+usage\s+limit\s+reached\|(?<timestamp>\d{9,13})\b/iu;

type ResetCandidate = {
  readonly epochSeconds: number;
  readonly source: string;
  readonly reached: boolean;
  readonly priority: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function epochSecondsFromUnixLike(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    if (typeof value === "string") {
      const parsed = DateTime.make(value);
      if (Option.isSome(parsed)) {
        const parsedMillis = DateTime.toEpochMillis(parsed.value);
        if (parsedMillis > 0) {
          return Math.floor(parsedMillis / 1000);
        }
      }
    }
    return undefined;
  }
  const epochSeconds =
    numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  return epochSeconds > 0 ? epochSeconds : undefined;
}

function isoFromEpochSeconds(epochSeconds: number | undefined): string | undefined {
  if (epochSeconds === undefined) {
    return undefined;
  }
  const millis = epochSeconds * 1000;
  if (!Number.isFinite(millis)) {
    return undefined;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

function readPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function collectResetCandidates(
  value: unknown,
  path: string,
  candidates: Array<ResetCandidate>,
): void {
  if (!isRecord(value)) {
    return;
  }

  const usedPercent = readPercent(value.usedPercent);
  const remainingPercent = readPercent(value.remainingPercent);
  const reached = usedPercent !== undefined ? usedPercent >= 100 : remainingPercent === 0;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/gu, "");
    const childPath = path ? `${path}.${key}` : key;
    if (
      normalizedKey === "resetsat" ||
      normalizedKey === "resetat" ||
      normalizedKey === "resettime"
    ) {
      const epochSeconds = epochSecondsFromUnixLike(child);
      if (epochSeconds !== undefined) {
        candidates.push({
          epochSeconds,
          source: childPath,
          reached,
          priority: key === "resetsAt" ? 2 : 1,
        });
      }
    } else if (
      normalizedKey === "resetsinseconds" ||
      normalizedKey === "resetinseconds" ||
      normalizedKey === "retryafterseconds"
    ) {
      const seconds = epochSecondsFromUnixLike(child);
      if (seconds !== undefined) {
        candidates.push({
          epochSeconds: Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1000) + seconds,
          source: childPath,
          reached,
          priority: 1,
        });
      }
    }

    if (isRecord(child)) {
      collectResetCandidates(child, childPath, candidates);
    } else if (Array.isArray(child)) {
      child.forEach((entry, index) =>
        collectResetCandidates(entry, `${childPath}[${index}]`, candidates),
      );
    }
  }
}

function bestResetCandidate(value: unknown): ResetCandidate | undefined {
  const candidates: Array<ResetCandidate> = [];
  collectResetCandidates(value, "", candidates);
  if (candidates.length === 0) {
    return undefined;
  }
  const reached = candidates.filter((candidate) => candidate.reached);
  const pool = reached.length > 0 ? reached : candidates;
  return pool.reduce((best, candidate) => {
    if (candidate.priority !== best.priority) {
      return candidate.priority > best.priority ? candidate : best;
    }
    return candidate.epochSeconds > best.epochSeconds ? candidate : best;
  });
}

function claudeResetFromMessage(message: string | undefined): ResetCandidate | undefined {
  if (!message) {
    return undefined;
  }
  const match = CLAUDE_USAGE_LIMIT_WITH_RESET_PATTERN.exec(message);
  const epochSeconds = epochSecondsFromUnixLike(match?.groups?.timestamp);
  return epochSeconds === undefined
    ? undefined
    : {
        epochSeconds,
        source: "message",
        reached: true,
        priority: 3,
      };
}

function containsUsageLimitText(value: unknown): boolean {
  if (typeof value === "string") {
    return USAGE_LIMIT_MESSAGE_PATTERN.test(value) || CLAUDE_USAGE_LIMIT_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsUsageLimitText);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) => USAGE_LIMIT_MESSAGE_PATTERN.test(key) || containsUsageLimitText(child),
  );
}

function codexErrorInfoIndicatesUsageLimit(value: unknown): boolean {
  if (value === "usageLimitExceeded") {
    return true;
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    return false;
  }
  return containsUsageLimitText(value);
}

function rateLimitPayloadIndicatesUsageLimit(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(rateLimitPayloadIndicatesUsageLimit);
  }
  if (!isRecord(value)) {
    return false;
  }
  const reachedType = trimText(value.rateLimitReachedType);
  if (reachedType?.toLowerCase().includes("usage_limit_reached") === true) {
    return true;
  }
  return Object.values(value).some(rateLimitPayloadIndicatesUsageLimit);
}

function claudeRateLimitEventIsRejected(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(claudeRateLimitEventIsRejected);
  }
  if (!isRecord(value)) {
    return false;
  }
  const status = trimText(value.status)?.toLowerCase();
  if (status === "rejected" || status === "denied" || status === "blocked") {
    return true;
  }
  return Object.values(value).some(claudeRateLimitEventIsRejected);
}

function codexErrorInfoHasHttp429(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(codexErrorInfoHasHttp429);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.httpStatusCode === 429) {
    return true;
  }
  return Object.values(value).some(codexErrorInfoHasHttp429);
}

function buildUsageLimitDetail(input: {
  readonly provider: string;
  readonly source: string;
  readonly message?: string | undefined;
  readonly raw?: unknown;
  readonly resetCandidate?: ResetCandidate | undefined;
}): RuntimeUsageLimitDetail {
  const resetCandidate =
    input.resetCandidate ?? claudeResetFromMessage(input.message) ?? bestResetCandidate(input.raw);
  return {
    kind: "usage-limit",
    provider: input.provider,
    source: input.source,
    ...(resetCandidate !== undefined
      ? {
          resetsAtEpochSeconds: resetCandidate.epochSeconds,
          resetsAt: isoFromEpochSeconds(resetCandidate.epochSeconds),
          resetSource: resetCandidate.source,
        }
      : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
  };
}

export function detectClaudeUsageLimit(input: {
  readonly message?: string | undefined;
  readonly raw?: unknown;
  readonly source: string;
}): RuntimeUsageLimitDetail | undefined {
  const messageIndicatesLimit =
    input.message !== undefined &&
    (CLAUDE_USAGE_LIMIT_PATTERN.test(input.message) ||
      USAGE_LIMIT_MESSAGE_PATTERN.test(input.message));
  const rateLimitEventIndicatesRejectedUsageLimit =
    input.source === "rate_limit_event" &&
    claudeRateLimitEventIsRejected(input.raw) &&
    (containsUsageLimitText(input.raw) || bestResetCandidate(input.raw) !== undefined);

  if (!messageIndicatesLimit && !rateLimitEventIndicatesRejectedUsageLimit) {
    return undefined;
  }

  return buildUsageLimitDetail({
    provider: "claudeAgent",
    source: input.source,
    message: input.message,
    raw: input.raw,
  });
}

export function detectCodexUsageLimit(input: {
  readonly message?: string | undefined;
  readonly codexErrorInfo?: unknown;
  readonly raw?: unknown;
  readonly source: string;
}): RuntimeUsageLimitDetail | undefined {
  const structuredUsageLimit = codexErrorInfoIndicatesUsageLimit(input.codexErrorInfo);
  const messageUsageLimit =
    input.message !== undefined && USAGE_LIMIT_MESSAGE_PATTERN.test(input.message);
  const messageRateLimit429 =
    input.message !== undefined &&
    /\b(?:429|rate\s+limit|too\s+many\s+requests)\b/iu.test(input.message) &&
    codexErrorInfoHasHttp429(input.codexErrorInfo);
  const rateLimitUsageLimit =
    input.source === "account/rateLimits/updated" && rateLimitPayloadIndicatesUsageLimit(input.raw);

  if (!structuredUsageLimit && !messageUsageLimit && !messageRateLimit429 && !rateLimitUsageLimit) {
    return undefined;
  }

  return buildUsageLimitDetail({
    provider: "codex",
    source: input.source,
    message: input.message,
    raw: input.raw,
  });
}

export function isUsageLimitDetail(value: unknown): value is RuntimeUsageLimitDetail {
  return isRecord(value) && value.kind === "usage-limit";
}
