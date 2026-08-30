import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  makeUnavailableUsageLimits,
  makeUsageLimitsSnapshot,
  type RawUsageWindowInput,
} from "./providerUsageLimits.ts";

const CODEX_SESSION_WINDOW_DURATION_MINS = 300; // ~5 hours (short / session window)
const CODEX_WEEKLY_WINDOW_DURATION_MINS = 10080; // 7 days (weekly window)
const CODEX_MONTHLY_WINDOW_DURATION_MINS = 30 * 24 * 60;

const UNAVAILABLE_REASON = "No Codex subscription quota windows reported.";

/** Minimal structural view of a Codex rate-limit window. */
export interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

/** Minimal structural view of a Codex rate-limit snapshot. */
export interface CodexRateLimitSnapshot {
  readonly planType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

function epochSecondsToIso(value: number): string | undefined {
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
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

  const reported = [input.snapshot.primary, input.snapshot.secondary].filter(
    (window): window is CodexRateLimitWindow =>
      Boolean(window) && Number.isFinite(window?.usedPercent),
  );
  const isMonthlyPlan = input.snapshot.planType === "free" || input.snapshot.planType === "go";
  const planWindows = isMonthlyPlan ? reported.slice(0, 1) : reported;

  // `primary`/`secondary` are positions, not durations. Prefer the duration
  // supplied by Codex, but use plan-aware fallbacks when older servers omit it:
  // Free and Go expose one monthly allowance, while paid personal plans expose
  // the 5-hour session and weekly allowances. A lone duration-less paid window
  // remains weekly because Codex has shipped that response shape.
  const windows: RawUsageWindowInput[] = planWindows.map((window, index) => {
    const durationMins = isMonthlyPlan
      ? CODEX_MONTHLY_WINDOW_DURATION_MINS
      : typeof window.windowDurationMins === "number"
        ? window.windowDurationMins
        : planWindows.length > 1 && index === 0
          ? CODEX_SESSION_WINDOW_DURATION_MINS
          : CODEX_WEEKLY_WINDOW_DURATION_MINS;
    const resetsAt =
      typeof window.resetsAt === "number" ? epochSecondsToIso(window.resetsAt) : undefined;
    return {
      label: "",
      usedPercent: window.usedPercent,
      windowDurationMins: durationMins,
      ...(resetsAt ? { resetsAt } : {}),
    };
  });

  return makeUsageLimitsSnapshot({
    source: "codexAppServer",
    checkedAt: input.checkedAt,
    windows,
    unavailableReason: UNAVAILABLE_REASON,
  });
}
