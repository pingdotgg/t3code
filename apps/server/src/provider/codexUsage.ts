import {
  type CodexUsageSnapshot,
  type CodexUsageSnapshotSource,
  type CodexUsageWindow,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { sortCodexUsageWindowsForDisplay } from "@t3tools/shared/codexUsage";
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
  readonly limitName?: string | null;
  readonly primary?: RateLimitWindow | null;
  readonly secondary?: RateLimitWindow | null;
  readonly rateLimitReachedType?: string | null;
};

type RateLimitPayload = {
  readonly credits?: unknown;
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly planType?: string | null;
  readonly primary?: RateLimitWindow | null;
  readonly secondary?: RateLimitWindow | null;
  readonly rateLimitReachedType?: string | null;
  readonly rateLimits?: RateLimitBucket | null;
  readonly rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
  readonly rateLimitsByName?: Record<string, RateLimitBucket> | null;
};

const FIVE_HOUR_WINDOW_MINS = 300;
const WEEKLY_WINDOW_MINS = 10_080;

const FIVE_HOUR_LIMIT_IDS = new Set([
  "fivehour",
  "fivehourlimit",
  "five_hour_limit",
  "5hour",
  "5hourlimit",
  "5h",
  "5hlimit",
]);
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

function windowKindForLimitKey(
  limitKey: string | null | undefined,
): CodexUsageWindow["kind"] | null {
  const normalized = limitKey
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

function isRateLimitBucketPayload(payload: RateLimitPayload): boolean {
  return "primary" in payload || "secondary" in payload;
}

function hasBuckets(buckets: Record<string, RateLimitBucket> | null | undefined): boolean {
  return Boolean(buckets && Object.keys(buckets).length > 0);
}

function selectCodexBucket(payload: RateLimitPayload): RateLimitBucket | null {
  if (isRateLimitBucketPayload(payload)) {
    return payload;
  }
  return (
    payload.rateLimitsByLimitId?.codex ??
    payload.rateLimitsByName?.codex ??
    (hasBuckets(payload.rateLimitsByLimitId) || hasBuckets(payload.rateLimitsByName)
      ? null
      : payload.rateLimits) ??
    null
  );
}

function windowsFromBuckets(
  buckets: Record<string, RateLimitBucket> | null | undefined,
): CodexUsageWindow[] {
  if (!buckets) {
    return [];
  }
  const windows: CodexUsageWindow[] = [];
  for (const [limitKey, bucket] of Object.entries(buckets)) {
    const kind = windowKindForLimitKey(bucket.limitId ?? bucket.limitName ?? limitKey);
    if (!kind) {
      continue;
    }
    const window = normalizeWindow(bucket.primary ?? bucket.secondary, kind);
    if (window) {
      windows.push(window);
    }
  }
  return sortCodexUsageWindowsForDisplay(windows);
}

function windowsFromBucketGroups(
  ...groups: ReadonlyArray<Record<string, RateLimitBucket> | null | undefined>
): CodexUsageWindow[] {
  for (const group of groups) {
    const windows = windowsFromBuckets(group);
    if (windows.length > 0) {
      return windows;
    }
  }
  return [];
}

function rateLimitReachedTypeFromBuckets(
  buckets: Record<string, RateLimitBucket> | null | undefined,
): string | null {
  if (!buckets) {
    return null;
  }
  for (const [limitKey, bucket] of Object.entries(buckets)) {
    if (
      windowKindForLimitKey(bucket.limitId ?? bucket.limitName ?? limitKey) &&
      bucket.rateLimitReachedType
    ) {
      return bucket.rateLimitReachedType;
    }
  }
  return null;
}

function rateLimitReachedTypeFromBucketGroups(
  ...groups: ReadonlyArray<Record<string, RateLimitBucket> | null | undefined>
): string | null {
  for (const group of groups) {
    const rateLimitReachedType = rateLimitReachedTypeFromBuckets(group);
    if (rateLimitReachedType) {
      return rateLimitReachedType;
    }
  }
  return null;
}

function rateLimitReachedTypeFromSelectedBucket(
  bucket: RateLimitBucket | null,
  fallback: () => string | null,
): string | null {
  if (bucket && "rateLimitReachedType" in bucket) {
    return bucket.rateLimitReachedType ?? null;
  }
  return fallback();
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
        normalizeWindow(
          bucket.primary,
          windowKindForLimitKey(bucket.limitId ?? bucket.limitName) ?? "five-hour",
        ),
        normalizeWindow(bucket.secondary, "weekly"),
      ].filter((window): window is CodexUsageWindow => window !== null)
    : [];
  const windows =
    bucketWindows.length > 0
      ? sortCodexUsageWindowsForDisplay(bucketWindows)
      : windowsFromBucketGroups(input.payload.rateLimitsByLimitId, input.payload.rateLimitsByName);
  if (windows.length === 0) {
    return null;
  }

  return {
    providerInstanceId: input.providerInstanceId,
    checkedAt: input.checkedAt ?? DateTime.formatIso(DateTime.nowUnsafe()),
    windows,
    rateLimitReachedType: rateLimitReachedTypeFromSelectedBucket(bucket, () =>
      rateLimitReachedTypeFromBucketGroups(
        input.payload.rateLimitsByLimitId,
        input.payload.rateLimitsByName,
      ),
    ),
    source: input.source,
  };
}
