import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  makeUnavailableUsageLimits,
  makeUsageLimitsSnapshot,
  type RawUsageWindowInput,
} from "./providerUsageLimits.ts";

/**
 * Codex rate-limit windows are surfaced through two channels:
 *   - `account/rateLimits/read` — the full snapshot the provider status
 *     probe consumes during a scheduled refresh.
 *   - `account/rateLimits/updated` — sparse rolling updates the app-server
 *     pushes between refreshes.
 *
 * Both carry the same `{ usedPercent, resetsAt?, windowDurationMins? }`
 * window shape under optional `primary` / `secondary` keys, so the two
 * paths share one resolver. Keeping the window-building logic here means
 * the runtime ingestion path in `ProviderUsageState` can mirror how Claude
 * handles `account.rate-limits.updated` without re-implementing the
 * percentage / duration mapping inline.
 */

const CODEX_PRIMARY_WINDOW_DURATION_MINS = 300; // ~5 hours (short / session window)
const CODEX_SECONDARY_WINDOW_DURATION_MINS = 10080; // 7 days (weekly window)

const UNAVAILABLE_REASON = "No Codex subscription quota windows reported.";

/** Minimal structural view of a Codex rate-limit window. */
export interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

/** Minimal structural view of a Codex rate-limit snapshot. */
export interface CodexRateLimitSnapshot {
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

function readObjectRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readWindow(value: unknown): CodexRateLimitWindow | undefined {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }
  const usedPercent = readFiniteNumber(record.usedPercent);
  if (usedPercent === undefined) {
    return undefined;
  }
  return {
    usedPercent,
    ...(readFiniteNumber(record.resetsAt) !== undefined
      ? { resetsAt: record.resetsAt as number }
      : {}),
    ...(readFiniteNumber(record.windowDurationMins) !== undefined
      ? { windowDurationMins: record.windowDurationMins as number }
      : {}),
  };
}

function readSnapshot(value: unknown): CodexRateLimitSnapshot | undefined {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }
  const primary = readWindow(record.primary);
  const secondary = readWindow(record.secondary);
  if (!primary && !secondary) {
    return undefined;
  }
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/**
 * Resolve a Codex rate-limit snapshot into usage limits. Shared by the
 * provider status probe (full `read` response) and the runtime telemetry
 * ingestion path (sparse `updated` notification).
 */
export function resolveCodexRateLimitSnapshotUsageLimits(input: {
  readonly checkedAt: string;
  readonly snapshot?: CodexRateLimitSnapshot | null;
}): ServerProviderUsageLimits {
  if (!input.snapshot) {
    return makeUnavailableUsageLimits({
      source: "codexAppServer",
      checkedAt: input.checkedAt,
      reason: UNAVAILABLE_REASON,
    });
  }

  const windows: RawUsageWindowInput[] = [];

  const addWindow = (
    window: CodexRateLimitWindow | null | undefined,
    fallbackDurationMins: number,
    label: string,
  ) => {
    if (!window) return;
    const durationMins =
      typeof window.windowDurationMins === "number"
        ? window.windowDurationMins
        : fallbackDurationMins;
    windows.push({
      label,
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === "number"
        ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1000)) }
        : {}),
      ...(typeof durationMins === "number" ? { windowDurationMins: durationMins } : {}),
    });
  };

  addWindow(input.snapshot.primary, CODEX_PRIMARY_WINDOW_DURATION_MINS, "Session");
  addWindow(input.snapshot.secondary, CODEX_SECONDARY_WINDOW_DURATION_MINS, "Weekly");

  return makeUsageLimitsSnapshot({
    source: "codexAppServer",
    checkedAt: input.checkedAt,
    windows,
    unavailableReason: UNAVAILABLE_REASON,
  });
}

/**
 * Resolve Codex usage limits for a scheduled status refresh. Matches Claude
 * refresh behavior by preferring live runtime telemetry whenever it is
 * available, so a failed or empty `account/rateLimits/read` cannot replace
 * fresher limits cached from `account.rate-limits.updated` events.
 */
export function resolveCodexRefreshUsageLimits(input: {
  readonly runtimeUsageLimits: ServerProviderUsageLimits | undefined;
  readonly probedUsageLimits: ServerProviderUsageLimits;
  readonly isApiKeyAccount: boolean;
}): ServerProviderUsageLimits {
  if (input.isApiKeyAccount) {
    return input.probedUsageLimits;
  }
  if (input.runtimeUsageLimits?.available) {
    return input.runtimeUsageLimits;
  }
  return input.probedUsageLimits;
}

/**
 * Parse a sparse `account/rateLimits/updated` notification payload into
 * usage limits. Returns `undefined` when the payload carries no usable
 * windows, so the runtime ingestion path can fall back to the last known
 * snapshot rather than overwriting it with an unavailable stub.
 */
export function parseCodexRuntimeUsageLimits(input: {
  readonly checkedAt: string;
  readonly rateLimits: unknown;
}): ServerProviderUsageLimits | undefined {
  const eventRecord = readObjectRecord(input.rateLimits);
  // The notification nests the snapshot under `rateLimits`; the `read`
  // response is the snapshot itself. Accept either so the same parser
  // works for both shapes.
  const snapshot = readSnapshot(eventRecord?.rateLimits) ?? readSnapshot(input.rateLimits);
  if (!snapshot) {
    return undefined;
  }
  return resolveCodexRateLimitSnapshotUsageLimits({
    checkedAt: input.checkedAt,
    snapshot,
  });
}
