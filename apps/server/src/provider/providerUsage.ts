import type {
  ServerProviderUsage,
  ServerProviderUsageWindow,
  ServerProviderUsageWindowStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Pure normalization of provider rate-limit payloads into the
 * `ServerProviderUsage` contract shape.
 *
 * Claude's SDK emits one `rate_limit_event` per *binding* window (the
 * window currently constraining the account), so windows accumulate
 * across events keyed by `rateLimitType`. Codex sends sparse
 * `account/rateLimits/updated` snapshots whose `primary`/`secondary`
 * windows merge into the previously observed state the same way.
 */

const CLAUDE_WINDOW_META: Record<string, { readonly label: string; readonly order: number }> = {
  five_hour: { label: "5h", order: 0 },
  seven_day: { label: "1w", order: 1 },
  seven_day_sonnet: { label: "1w Sonnet", order: 2 },
  seven_day_opus: { label: "1w Opus", order: 3 },
  overage: { label: "Overage", order: 4 },
};

const CODEX_WINDOW_ORDER: Record<string, number> = {
  primary: 0,
  secondary: 1,
};

const windowOrder = (window: ServerProviderUsageWindow): number =>
  CLAUDE_WINDOW_META[window.key]?.order ?? CODEX_WINDOW_ORDER[window.key] ?? 99;

const sortWindows = (
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> =>
  [...windows].toSorted(
    (left, right) => windowOrder(left) - windowOrder(right) || left.key.localeCompare(right.key),
  );

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const finitePercent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 100)
    : undefined;

/** Provider payloads carry epoch timestamps in seconds; tolerate millis. */
const epochToIso = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const millis = value > 1e12 ? value : value * 1000;
  return DateTime.make(millis).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );
};

const upsertWindows = (
  previous: ServerProviderUsage | undefined,
  nextWindows: ReadonlyArray<ServerProviderUsageWindow>,
  nowIso: string,
): ServerProviderUsage => {
  const merged = new Map((previous?.windows ?? []).map((window) => [window.key, window] as const));
  for (const window of nextWindows) {
    merged.set(window.key, window);
  }
  return {
    windows: sortWindows([...merged.values()]),
    updatedAt: nowIso,
  };
};

const claudeWindowStatus = (status: unknown): ServerProviderUsageWindowStatus | undefined => {
  switch (status) {
    case "allowed":
      return "ok";
    case "allowed_warning":
      return "warning";
    case "rejected":
      return "exhausted";
    default:
      return undefined;
  }
};

/**
 * Apply a Claude `account.rate-limits.updated` runtime payload
 * (`payload.rateLimits` = the SDK `rate_limit_event` message). Returns
 * the merged usage, or `undefined` when the payload carries nothing
 * displayable.
 */
export const applyClaudeRateLimitEvent = (
  previous: ServerProviderUsage | undefined,
  payload: unknown,
  nowIso: string,
): ServerProviderUsage | undefined => {
  const message = asRecord(asRecord(payload)?.rateLimits);
  const info = asRecord(message?.rate_limit_info);
  if (!info) {
    return undefined;
  }
  const usedPercent = finitePercent(info.utilization);
  if (usedPercent === undefined) {
    return undefined;
  }
  const key = typeof info.rateLimitType === "string" ? info.rateLimitType : "five_hour";
  const meta = CLAUDE_WINDOW_META[key];
  const status = claudeWindowStatus(info.status);
  const resetsAt = epochToIso(info.resetsAt);
  return upsertWindows(
    previous,
    [
      {
        key,
        label: meta?.label ?? key,
        usedPercent,
        ...(status !== undefined ? { status } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      },
    ],
    nowIso,
  );
};

const codexWindowLabel = (windowDurationMins: unknown, fallback: string): string => {
  if (
    typeof windowDurationMins !== "number" ||
    !Number.isFinite(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return fallback;
  }
  const minutes = Math.round(windowDurationMins);
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return weeks === 1 ? "1w" : `${weeks}w`;
  }
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
};

const codexWindow = (
  key: "primary" | "secondary",
  value: unknown,
): ServerProviderUsageWindow | undefined => {
  const window = asRecord(value);
  if (!window) {
    return undefined;
  }
  const usedPercent = finitePercent(window.usedPercent);
  if (usedPercent === undefined) {
    return undefined;
  }
  const resetsAt = epochToIso(window.resetsAt);
  const status: ServerProviderUsageWindowStatus | undefined =
    usedPercent >= 100 ? "exhausted" : undefined;
  return {
    key,
    label: codexWindowLabel(window.windowDurationMins, key),
    usedPercent,
    ...(status !== undefined ? { status } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
};

const codexWindowsFromSnapshot = (
  snapshot: Record<string, unknown> | undefined,
): ReadonlyArray<ServerProviderUsageWindow> => {
  if (!snapshot) {
    return [];
  }
  return [
    codexWindow("primary", snapshot.primary),
    codexWindow("secondary", snapshot.secondary),
  ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
};

/**
 * Extract the Codex `RateLimitSnapshot` from either the runtime event
 * payload (`payload.rateLimits` = the whole `account/rateLimits/updated`
 * notification, i.e. `{ rateLimits: snapshot }`) or a bare snapshot.
 */
const codexSnapshotFromPayload = (payload: unknown): Record<string, unknown> | undefined => {
  const outer = asRecord(asRecord(payload)?.rateLimits);
  if (!outer) {
    return undefined;
  }
  return asRecord(outer.rateLimits) ?? outer;
};

/**
 * Apply a Codex `account.rate-limits.updated` runtime payload. Sparse:
 * only the windows present in the update replace previously observed
 * ones. Returns `undefined` when nothing displayable arrived.
 */
export const applyCodexRateLimitEvent = (
  previous: ServerProviderUsage | undefined,
  payload: unknown,
  nowIso: string,
): ServerProviderUsage | undefined => {
  const windows = codexWindowsFromSnapshot(codexSnapshotFromPayload(payload));
  if (windows.length === 0) {
    return undefined;
  }
  return upsertWindows(previous, windows, nowIso);
};

/**
 * Build usage from a Codex `account/rateLimits/read` response taken at
 * provider probe time.
 */
export const usageFromCodexRateLimitsRead = (
  response: unknown,
  nowIso: string,
): ServerProviderUsage | undefined => {
  const windows = codexWindowsFromSnapshot(asRecord(asRecord(response)?.rateLimits));
  if (windows.length === 0) {
    return undefined;
  }
  return { windows: sortWindows(windows), updatedAt: nowIso };
};

/** Prefer the more recently updated of two usage snapshots. */
export const pickNewestUsage = (
  left: ServerProviderUsage | undefined,
  right: ServerProviderUsage | undefined,
): ServerProviderUsage | undefined => {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right.updatedAt > left.updatedAt ? right : left;
};
