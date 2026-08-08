import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  makeUnavailableUsageLimits,
  makeUsageLimitsSnapshot,
  type RawUsageWindowInput,
} from "./providerUsageLimits.ts";

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
    if (!window || !Number.isFinite(window.usedPercent)) return;
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
