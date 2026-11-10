import * as DateTime from "effect/DateTime";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import type { ProviderUsageLimitsReport } from "@t3tools/provider-core/server/snapshot";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

const isoMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Muse's account-wide report as Limits windows, with its tier as the plan. */
export function museUsageToLimits(usage: MuseSubscriptionUsage): ProviderUsageLimitsReport {
  const tier = usage.tier.trim();
  return {
    checkedAt: isoMillis(usage.observedAtMs),
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: clampPercent(usage.window.usedPercent),
        resetsAt: isoMillis(usage.window.resetsAtMs),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        resetsAt: isoMillis(usage.weekly.resetsAtMs),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
    ...(tier ? { authLabel: tier } : {}),
  };
}

/** Credential proxies may omit error.quota from 429 refusals; inspect text too. */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/** Resume only after all exhausted windows reset; use the latest future reset from quota, refusal, or usage. */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? isoMillis(Math.max(...resets)) : null;
}
