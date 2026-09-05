import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  collectLimitSources,
  collectLimitsGroups,
  providerLimitsLabel,
} from "@t3tools/shared/usageLimits";

export interface SubscriptionUsageRow {
  readonly label: string;
  readonly window: string;
  readonly usedPercent: number | null;
  readonly resetLabel: string;
  readonly expiresAt: number;
  readonly checkedAt: number;
}

export interface SubscriptionUsageSnapshot {
  readonly rows: readonly SubscriptionUsageRow[];
  readonly totalRows: number;
  readonly deepLink: string;
}

type Presentations = Parameters<typeof collectLimitsGroups>[0] &
  Parameters<typeof collectLimitSources>[0];
const MAX_AGE = 30 * 60_000;

/** Only display data crosses into OS storage; credentials and emails stay in the app. */
export function buildSubscriptionUsageSnapshot(
  presentations: Presentations,
  deepLink: string,
): SubscriptionUsageSnapshot {
  const rows: SubscriptionUsageRow[] = [];
  const add = (label: string, limits: ServerProviderUsageLimits, sourceFailed = false) => {
    const checkedAt = Date.parse(limits.checkedAt);
    if (limits.unavailable || sourceFailed || limits.windows.length === 0) {
      rows.push({
        label,
        window:
          limits.unavailable?.reason === "unsupported"
            ? "No subscription limits"
            : "Limits unavailable",
        usedPercent: null,
        resetLabel: "Open app for details",
        checkedAt,
        expiresAt: 0,
      });
      return;
    }
    for (const window of limits.windows) {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      rows.push({
        label,
        window: window.label,
        usedPercent: Math.round(Math.max(0, Math.min(100, window.usedPercent))),
        resetLabel: Number.isFinite(reset)
          ? `Resets ${new Date(reset).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
          : "Reset time unavailable",
        checkedAt,
        expiresAt: Math.min(checkedAt + MAX_AGE, Number.isFinite(reset) ? reset : Infinity),
      });
    }
  };
  const driverLabel = (driver: string) => ({ codex: "Codex", claudeAgent: "Claude" })[driver];
  for (const group of collectLimitsGroups(presentations)) {
    for (const provider of group.providers) {
      if (!provider.usageLimits) continue;
      const label = providerLimitsLabel(provider, driverLabel);
      add(
        group.environmentLabel ? `${group.environmentLabel} · ${label}` : label,
        provider.usageLimits,
      );
    }
  }
  for (const source of collectLimitSources(presentations)) {
    for (const [index, account] of source.accounts.entries()) {
      add(
        `${source.label} · ${driverLabel(account.driver) ?? account.driver} ${index + 1}`,
        account.usageLimits,
        Boolean(source.error),
      );
    }
    if (source.error && source.accounts.length === 0) {
      add(source.label, { checkedAt: source.checkedAt, windows: [] });
    }
  }
  // Most constrained windows stay visible in the smallest families. Stable
  // sorting preserves account order when two windows have the same quota.
  rows.sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1));
  return { rows: rows.slice(0, 8), totalRows: rows.length, deepLink };
}

/** Schedule expiry without pretending that a reset supplies a fresh quota reading. */
export function subscriptionUsageTimeline(snapshot: SubscriptionUsageSnapshot, now: number) {
  const dates = [
    now,
    ...new Set(snapshot.rows.map((row) => row.expiresAt).filter((at) => at > now)),
  ];
  return dates.sort((a, b) => a - b).map((at) => ({ date: new Date(at), props: snapshot }));
}
