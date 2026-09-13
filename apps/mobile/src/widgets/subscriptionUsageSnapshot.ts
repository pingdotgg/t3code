import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

export interface SubscriptionUsageSnapshot {
  url?: string;
  checkedAt: number;
  providers: Array<{
    name: string;
    detail: string;
    windows: Array<{ kind?: string; label: string; remaining: number; reset: string }>;
    expiresAt: number;
    totalWindows: number;
  }>;
}

// Snapshots expire after 15 minutes; background refresh needs a
// separate authenticated transport while the mobile app is suspended.
const SNAPSHOT_MAX_AGE = 15 * 60_000;
export const WIDGET_REFRESH_INTERVAL = 5 * 60_000;

/** Bound probes across config updates, reconnects, and foreground transitions. */
export function createWidgetRefresher<Id>(refresh: (id: Id) => Promise<unknown>) {
  const attempted = new Map<Id, number>();
  const pending = new Set<Id>();
  return async (connected: readonly Id[], now: number) => {
    await Promise.allSettled(
      connected.map(async (id) => {
        if (pending.has(id) || now - (attempted.get(id) ?? -Infinity) < WIDGET_REFRESH_INTERVAL)
          return;
        attempted.set(id, now);
        pending.add(id);
        try {
          await refresh(id);
        } finally {
          pending.delete(id);
        }
      }),
    );
  };
}

function subscriptionUsageProps(
  accounts: readonly LimitAccount[],
  now: number,
): SubscriptionUsageSnapshot {
  const pools = collectLimitPools(accounts, now);
  const checked = accounts
    .filter((account) => account.driver === "codex" || account.driver === "claudeAgent")
    .map((account) => Date.parse(account.limits.checkedAt));
  return {
    checkedAt: checked.length > 0 && checked.every(Number.isFinite) ? Math.min(...checked) : 0,
    providers: (["codex", "claudeAgent"] as const).map((driver) => {
      const pool = pools.find((candidate) => candidate.driver === driver);
      const name = driver === "codex" ? "Codex" : "Claude";
      if (!pool)
        return { name, detail: "No limits available", windows: [], expiresAt: 0, totalWindows: 0 };
      const checkedAt = Math.min(...pool.accounts.map((a) => Date.parse(a.limits.checkedAt)));
      const expiresAt = Math.min(
        checkedAt + SNAPSHOT_MAX_AGE,
        ...pool.windows.flatMap((window) => window.resets.map((reset) => reset.at)),
      );
      const fresh = Number.isFinite(expiresAt) && expiresAt > now;
      const sortedWindows = [...pool.windows].sort(
        (a, b) => a.remainingPercent - b.remainingPercent,
      );
      // Keep a session and weekly limit when scoped limits fill the storage budget.
      const selectedWindows = [
        ...new Set([
          sortedWindows.find((window) => window.kind === "session"),
          sortedWindows.find((window) => window.kind === "weekly"),
          ...sortedWindows,
        ]),
      ]
        .filter((window) => window !== undefined)
        .slice(0, 6)
        .sort((a, b) => a.remainingPercent - b.remainingPercent);
      return {
        name,
        detail: !fresh
          ? "Open T3 to refresh"
          : pool.accounts.length > 1
            ? `${pool.accounts.length} accounts · pooled`
            : "Subscription remaining",
        expiresAt: fresh ? expiresAt : 0,
        totalWindows: fresh ? pool.windows.length : 0,
        windows: fresh
          ? selectedWindows.map((window) => ({
              kind: window.kind,
              label: window.label,
              remaining: Math.round(window.remainingPercent),
              reset: window.resets[0]
                ? `Next reset ${new Date(window.resets[0].at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}`
                : "Reset time unavailable",
            }))
          : [],
      };
    }),
  };
}

/** Deduplicate accounts before pooling, and only publish display data to the OS. */
export function buildSubscriptionUsageSnapshot(
  presentations: LimitPresentations,
  url: string,
): SubscriptionUsageSnapshot {
  // Freshness is evaluated at publication/render time, not on unrelated config emissions.
  return { ...subscriptionUsageProps(collectLimitAccounts(presentations), 0), url };
}

export function subscriptionUsageTimeline(snapshot: SubscriptionUsageSnapshot, now: number) {
  const deadlines = [...new Set(snapshot.providers.map((p) => p.expiresAt))]
    .filter((deadline) => deadline > now)
    .sort((a, b) => a - b);
  return [now, ...deadlines].map((date) => ({
    date: new Date(date),
    props: {
      ...snapshot,
      providers: snapshot.providers.map((provider) =>
        provider.windows.length > 0 && provider.expiresAt <= date
          ? { ...provider, detail: "Open T3 to refresh", windows: [], totalWindows: 0 }
          : provider,
      ),
    },
  }));
}
