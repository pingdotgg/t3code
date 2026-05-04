import {
  type CodexUsageSnapshot,
  type CodexUsageSnapshotSource,
  type CodexUsageWindow,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

type RateLimitWindow = {
  readonly usedPercent?: number | null;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
  readonly windowDurationMinutes?: number | null;
};

type RateLimitBucket = {
  readonly limitId?: string | null;
  readonly primary?: RateLimitWindow | null;
  readonly secondary?: RateLimitWindow | null;
  readonly rateLimitReachedType?: string | null;
};

type RateLimitPayload = {
  readonly rateLimits?: RateLimitBucket | null;
  readonly rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
};

const FIVE_HOUR_WINDOW_MINS = 300;
const WEEKLY_WINDOW_MINS = 10_080;

const FIVE_HOUR_LIMIT_IDS = new Set(["fivehourlimit", "five_hour_limit", "5hourlimit", "5h"]);
const WEEKLY_LIMIT_IDS = new Set(["weeklylimit", "weekly_limit", "week", "weekly"]);

function unixSecondsToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return DateTime.make(value * 1000).pipe(
    Option.match({
      onNone: () => null,
      onSome: DateTime.formatIso,
    }),
  );
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function windowKindForDuration(
  windowDurationMins: number | null | undefined,
): CodexUsageWindow["kind"] | null {
  if (windowDurationMins === FIVE_HOUR_WINDOW_MINS) {
    return "five-hour";
  }
  if (windowDurationMins === WEEKLY_WINDOW_MINS) {
    return "weekly";
  }
  return null;
}

function windowKindForLimitId(limitId: string | null | undefined): CodexUsageWindow["kind"] | null {
  const normalized = limitId
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
  if (!normalized) {
    return null;
  }
  if (FIVE_HOUR_LIMIT_IDS.has(normalized)) {
    return "five-hour";
  }
  if (WEEKLY_LIMIT_IDS.has(normalized)) {
    return "weekly";
  }
  return null;
}

function normalizeWindow(
  window: RateLimitWindow | null | undefined,
  fallbackKind?: CodexUsageWindow["kind"] | null,
): CodexUsageWindow | null {
  if (!window || typeof window.usedPercent !== "number") {
    return null;
  }
  const windowDurationMins = window.windowDurationMins ?? window.windowDurationMinutes;
  const kind = windowKindForDuration(windowDurationMins) ?? fallbackKind;
  if (!kind) {
    return null;
  }
  const usedPercent = normalizePercent(window.usedPercent);
  return {
    kind,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: unixSecondsToIso(window.resetsAt),
    windowDurationMins: typeof windowDurationMins === "number" ? windowDurationMins : null,
  };
}

function selectCodexBucket(payload: RateLimitPayload): RateLimitBucket | null {
  return payload.rateLimitsByLimitId?.codex ?? payload.rateLimits ?? null;
}

function windowsFromLimitIdBuckets(
  buckets: Record<string, RateLimitBucket> | null | undefined,
): CodexUsageWindow[] {
  if (!buckets) {
    return [];
  }
  const windows: CodexUsageWindow[] = [];
  for (const [limitId, bucket] of Object.entries(buckets)) {
    const kind = windowKindForLimitId(limitId);
    if (!kind) {
      continue;
    }
    const window = normalizeWindow(bucket.primary ?? bucket.secondary, kind);
    if (window) {
      windows.push(window);
    }
  }
  return windows;
}

export function normalizeCodexUsageSnapshot(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly payload: RateLimitPayload;
  readonly source: CodexUsageSnapshotSource;
  readonly checkedAt?: string;
}): CodexUsageSnapshot | null {
  const bucket = selectCodexBucket(input.payload);
  const bucketWindows = bucket
    ? [
        normalizeWindow(bucket.primary, windowKindForLimitId(bucket.limitId) ?? "five-hour"),
        normalizeWindow(bucket.secondary, "weekly"),
      ].filter((window): window is CodexUsageWindow => window !== null)
    : [];
  const windows =
    bucketWindows.length > 0
      ? bucketWindows
      : windowsFromLimitIdBuckets(input.payload.rateLimitsByLimitId);
  if (windows.length === 0) {
    return null;
  }

  return {
    providerInstanceId: input.providerInstanceId,
    checkedAt: input.checkedAt ?? DateTime.formatIso(DateTime.nowUnsafe()),
    windows,
    rateLimitReachedType: bucket?.rateLimitReachedType ?? null,
    source: input.source,
  };
}
