import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  collectLimitAccounts,
  collectLimitPools,
  remainingPercent,
  type LimitAccount,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

import { providerColors } from "../features/usage/providerColors";
import type { WidgetTheme } from "./widgetTheme";

export interface WidgetLimitAccount {
  name: string;
  color?: string;
  /** Absent when this account does not report the window. */
  remaining?: number;
  refill?: number;
  resetsAt?: number;
  reset?: string;
  durationMs?: number;
}

export interface SubscriptionUsageSnapshot {
  theme?: WidgetTheme;
  url?: string;
  checkedAt: number;
  providers: Array<{
    name: string;
    colors?: { light: string; dark: string };
    detail: string;
    windows: Array<{
      kind?: string;
      label: string;
      remaining: number;
      reset: string;
      accounts?: WidgetLimitAccount[];
    }>;
    expiresAt: number;
    totalWindows: number;
  }>;
}

// Snapshots expire after 15 minutes; suspended refresh requires a separate authenticated transport.
const SNAPSHOT_MAX_AGE = 15 * 60_000;
export const WIDGET_REFRESH_INTERVAL = 5 * 60_000;

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

// Widget snapshots must not persist account emails.
function accountName(account: LimitAccount) {
  if (account.displayName && !account.displayName.includes("@")) return account.displayName;
  const email = account.email ?? account.displayName;
  if (!email?.includes("@")) return "Account";
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
}

function clockLabel(at: number, from: number) {
  const time = { hour: "numeric", minute: "2-digit" } as const;
  if (new Date(at).toDateString() === new Date(from).toDateString())
    return new Date(at).toLocaleTimeString(undefined, time);
  return new Date(at).toLocaleString(
    undefined,
    at - from < 6 * 86_400_000 ? { weekday: "short", ...time } : { month: "short", day: "numeric" },
  );
}

function widgetAccounts(window: LimitPoolWindow): WidgetLimitAccount[] {
  return window.columns.map((column) => {
    const color = normalizeProviderAccentColor(column.account.accentColor);
    // expo-widgets cannot convert an explicit undefined into a Kotlin value.
    const account = { name: accountName(column.account), ...(color && { color }) };
    if (column.window === null) return account;
    const resetsAt = column.window.resetsAt ? Date.parse(column.window.resetsAt) : NaN;
    const reset = Number.isFinite(resetsAt);
    return {
      ...account,
      remaining: remainingPercent(column.window),
      refill: reset ? column.refillPercent : 0,
      ...(reset && {
        resetsAt,
        reset: clockLabel(resetsAt, Date.parse(column.account.limits.checkedAt)),
      }),
      ...(column.window.windowDurationMins && {
        durationMs: column.window.windowDurationMins * 60_000,
      }),
    };
  });
}

// A reset at or before its account's observation already happened, so it cannot expire the snapshot.
const isUpcoming = (reset: LimitPoolWindow["resets"][number]) =>
  reset.at > Date.parse(reset.member.account.limits.checkedAt);

function subscriptionUsageProps(
  accounts: readonly LimitAccount[],
  now: number,
  configuredDrivers: ReadonlySet<string>,
  maxWindowsPerProvider: number,
): SubscriptionUsageSnapshot {
  const pools = collectLimitPools(accounts, now);
  const checked = accounts
    .filter((account) => account.driver === "codex" || account.driver === "claudeAgent")
    .map((account) => Date.parse(account.limits.checkedAt));
  return {
    checkedAt: checked.length > 0 && checked.every(Number.isFinite) ? Math.min(...checked) : 0,
    providers: (["codex", "claudeAgent"] as const)
      .filter(
        (driver) =>
          configuredDrivers.has(driver) || accounts.some((account) => account.driver === driver),
      )
      .map((driver) => {
        const pool = pools.find((candidate) => candidate.driver === driver);
        const name = driver === "codex" ? "Codex" : "Claude";
        const kind = driver === "codex" ? "codex" : "claude";
        const colors = { light: providerColors("light")[kind], dark: providerColors("dark")[kind] };
        if (!pool)
          return {
            name,
            colors,
            detail: "No limits available",
            windows: [],
            expiresAt: 0,
            totalWindows: 0,
          };
        const checkedAt = Math.min(...pool.accounts.map((a) => Date.parse(a.limits.checkedAt)));
        const expiresAt = Math.min(
          checkedAt + SNAPSHOT_MAX_AGE,
          ...pool.windows.flatMap((window) =>
            window.resets.filter(isUpcoming).map((reset) => reset.at),
          ),
        );
        const fresh = Number.isFinite(expiresAt) && expiresAt > now;
        const sortedWindows = [...pool.windows].sort(
          (a, b) => a.remainingPercent - b.remainingPercent,
        );
        const selectedWindows = [
          ...new Set([
            sortedWindows.find((window) => window.kind === "session"),
            sortedWindows.find((window) => window.kind === "weekly"),
            ...sortedWindows,
          ]),
        ]
          .filter((window) => window !== undefined)
          .slice(0, maxWindowsPerProvider)
          .sort((a, b) => a.remainingPercent - b.remainingPercent);
        return {
          name,
          colors,
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
                  ? `${isUpcoming(window.resets[0]) ? "Next reset" : "Reset"} ${new Date(
                      window.resets[0].at,
                    ).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}`
                  : "Reset time unavailable",
                accounts: widgetAccounts(window),
              }))
            : [],
        };
      }),
  };
}

export function buildSubscriptionUsageSnapshot(
  presentations: LimitPresentations,
  url: string,
  maxWindowsPerProvider = 6,
): SubscriptionUsageSnapshot {
  const configuredDrivers = new Set(
    [...presentations.values()].flatMap((presentation) =>
      (presentation.serverConfig?.providers ?? [])
        // Servers report default-enabled drivers even when their CLI is missing.
        .filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.usageLimits?.unavailable?.reason !== "unsupported",
        )
        .map((provider) => provider.driver),
    ),
  );
  return {
    ...subscriptionUsageProps(
      collectLimitAccounts(presentations),
      0,
      configuredDrivers,
      maxWindowsPerProvider,
    ),
    url,
  };
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
