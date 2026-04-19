import type {
  AccountRateLimitBucket,
  AccountRateLimitWindow,
  AccountRateLimitsSnapshot,
} from "@t3tools/contracts";

type WindowKind = "primary" | "secondary";
type Candidate = {
  bucket: AccountRateLimitBucket;
  kind: WindowKind;
  window: AccountRateLimitWindow;
  index: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const numberValue = (value: unknown) => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};

const stringValue = (value: unknown) => (typeof value === "string" && value.trim()) || undefined;

const firstNumber = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) return value;
  }
};

const oneOrNone = <T>(value: T | undefined): T[] => (value ? [value] : []);

function parseWindow(value: unknown): AccountRateLimitWindow | undefined {
  if (!isRecord(value)) return;
  const rawUsedPercent = firstNumber(value, ["usedPercent", "used_percent"]);
  if (rawUsedPercent === undefined) return;

  const usedPercent = Math.max(0, Math.min(100, rawUsedPercent));
  const duration = firstNumber(value, [
    "windowDurationMins",
    "window_duration_mins",
    "windowDurationMinutes",
    "window_duration_minutes",
  ]);
  const rawResetsAt = firstNumber(value, ["resetsAt", "resets_at", "resetAt", "reset_at"]);
  const resetsAt =
    rawResetsAt !== undefined && rawResetsAt >= 0 ? Math.floor(rawResetsAt) : undefined;
  const resetsAtIso =
    resetsAt !== undefined && Number.isFinite(new Date(resetsAt * 1000).getTime())
      ? new Date(resetsAt * 1000).toISOString()
      : undefined;

  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(duration !== undefined && duration >= 0
      ? { windowDurationMins: Math.floor(duration) }
      : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(resetsAtIso ? { resetsAtIso } : {}),
  };
}

function parseBucket(value: unknown, fallbackLimitId?: string): AccountRateLimitBucket | undefined {
  if (!isRecord(value)) return;
  const limitId =
    stringValue(value.limitId) ?? stringValue(value.limit_id) ?? stringValue(fallbackLimitId);
  if (!limitId) return;

  const primary = parseWindow(value.primary);
  const secondary = parseWindow(value.secondary);
  if (!primary && !secondary) return;

  const limitName =
    value.limitName === null || value.limit_name === null
      ? null
      : (stringValue(value.limitName) ?? stringValue(value.limit_name));

  return {
    limitId,
    ...(limitName !== undefined ? { limitName } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function parseBuckets(value: unknown): AccountRateLimitBucket[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.buckets))
    return value.buckets.flatMap((bucket) => oneOrNone(parseBucket(bucket)));

  const byId = value.rateLimitsByLimitId ?? value.rate_limits_by_limit_id;
  if (isRecord(byId)) {
    const buckets = Object.entries(byId).flatMap(([id, bucket]) =>
      oneOrNone(parseBucket(bucket, id)),
    );
    if (buckets.length) return buckets;
  }

  return oneOrNone(parseBucket(value.rateLimits ?? value.rate_limits ?? value));
}

function compareCandidates(left: Candidate, right: Candidate) {
  return (
    left.window.remainingPercent - right.window.remainingPercent ||
    (left.window.resetsAt ?? Infinity) - (right.window.resetsAt ?? Infinity) ||
    (left.kind === right.kind ? 0 : left.kind === "primary" ? -1 : 1) ||
    left.index - right.index
  );
}

function selectWindow(buckets: AccountRateLimitBucket[]): AccountRateLimitsSnapshot["selected"] {
  const candidates = buckets.flatMap((bucket, index): Candidate[] => [
    ...(bucket.primary
      ? [{ bucket, kind: "primary" as const, window: bucket.primary, index }]
      : []),
    ...(bucket.secondary
      ? [{ bucket, kind: "secondary" as const, window: bucket.secondary, index }]
      : []),
  ]);
  const selected = candidates.toSorted(compareCandidates)[0];
  return selected
    ? {
        limitId: selected.bucket.limitId,
        ...(selected.bucket.limitName !== undefined
          ? { limitName: selected.bucket.limitName }
          : {}),
        windowKind: selected.kind,
        window: selected.window,
      }
    : null;
}

export function normalizeAccountRateLimits(value: unknown): AccountRateLimitsSnapshot | undefined {
  const buckets = parseBuckets(value);
  return buckets.length ? { buckets, selected: selectWindow(buckets) } : undefined;
}
