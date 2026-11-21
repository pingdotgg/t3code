import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  collectLimitAccounts,
  collectLimitPools,
  remainingPercent,
  type LimitAccount,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";

import { providerColors } from "../features/usage/providerColors";
import type { WidgetTheme } from "./widgetTheme";

/**
 * Copy for the widget, which runs without the app's catalogs. `{name}` tokens are filled in by the
 * widget; `moreInApp` is keyed by count.
 */
export interface SubscriptionUsageText {
  refresh: string;
  noSessionLimit: string;
  noWeeklyLimit: string;
  subscriptionRemaining: string;
  percentLeft: string;
  windowPercentLeft: string;
  left: string;
  notApplicable: string;
  openApp: string;
  noLimits: string;
  asOf: string;
  tapToConnect: string;
  providerAccessibility: string;
  windowAccessibility: string;
  moreInApp: Record<string, string>;
}

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
  text?: SubscriptionUsageText;
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
function accountName(account: LimitAccount, resolve: MessageResolver) {
  if (account.displayName && !account.displayName.includes("@")) return account.displayName;
  const email = account.email ?? account.displayName;
  if (!email?.includes("@"))
    return resolve(msg("Account", { $context: "an unnamed provider account" }));
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

function widgetAccounts(window: LimitPoolWindow, resolve: MessageResolver): WidgetLimitAccount[] {
  const seen = new Map<string, number>();
  return window.columns.map((column) => {
    // Redacted initials can collide, and the widget keys segments by name.
    const base = accountName(column.account, resolve);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const color = normalizeProviderAccentColor(column.account.accentColor);
    // expo-widgets cannot convert an explicit undefined into a Kotlin value.
    const account = { name: count > 1 ? `${base}${count}` : base, ...(color && { color }) };
    if (column.window === null) return account;
    const checkedAt = Date.parse(column.account.limits.checkedAt);
    const resetsAt = column.window.resetsAt ? Date.parse(column.window.resetsAt) : NaN;
    // A reset at or before the observation already happened.
    const reset = resetsAt > checkedAt;
    return {
      ...account,
      remaining: remainingPercent(column.window),
      refill: reset ? column.refillPercent : 0,
      ...(reset && {
        resetsAt,
        reset: clockLabel(resetsAt, checkedAt),
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

const resetTime = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function subscriptionUsageText(
  resolve: MessageResolver,
  maxHiddenWindows: number,
): SubscriptionUsageText {
  return {
    refresh: resolve(msg("Open {app} to refresh", { app: "T3" })),
    noSessionLimit: resolve(msg("No session limit reported")),
    noWeeklyLimit: resolve(msg("No weekly limit reported")),
    subscriptionRemaining: resolve(msg("Subscription remaining")),
    percentLeft: resolve(msg("{remaining}% left", { remaining: "{remaining}" })),
    windowPercentLeft: resolve(
      msg("{window} · {remaining}% left", { window: "{window}", remaining: "{remaining}" }),
    ),
    left: resolve(msg("left", { $context: "follows a bold percentage, as in 40% left" })),
    notApplicable: resolve(msg("N/A", { $context: "no usage limit for the chosen period" })),
    openApp: resolve(msg("Open {app}", { app: "T3" })),
    noLimits: resolve(msg("No subscription limits available.")),
    asOf: resolve(msg("As of {time}", { time: "{time}" })),
    tapToConnect: resolve(msg("Tap to connect in {app}", { app: "T3" })),
    providerAccessibility: resolve(
      // oxlint-disable-next-line t3code/no-untranslated-copy -- placeholders the widget fills in
      msg("{provider}. {detail}.", { provider: "{provider}", detail: "{detail}" }),
    ),
    windowAccessibility: resolve(
      msg("{provider}, {window}, {remaining} percent remaining. {reset}. {detail}.", {
        provider: "{provider}",
        window: "{window}",
        remaining: "{remaining}",
        reset: "{reset}",
        // oxlint-disable-next-line t3code/no-untranslated-copy -- placeholders the widget fills in
        detail: "{detail}",
      }),
    ),
    moreInApp: Object.fromEntries(
      Array.from({ length: maxHiddenWindows }, (_, index) => [
        String(index + 1),
        resolve(
          msg("{count, plural, one {{count} more in {app}} other {{count} more in {app}}}", {
            count: index + 1,
            app: "T3",
          }),
        ),
      ]),
    ),
  };
}

function subscriptionUsageProps(
  accounts: readonly LimitAccount[],
  now: number,
  configuredDrivers: ReadonlySet<string>,
  maxWindowsPerProvider: number,
  resolve: MessageResolver,
): SubscriptionUsageSnapshot {
  // One row per provider: the widget has no room for a row per CLI Proxy source.
  const pools = collectLimitPools(accounts, now, { splitSources: false });
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
            detail: resolve(msg("No limits available")),
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
            ? resolve(msg("Open {app} to refresh", { app: "T3" }))
            : pool.accounts.length > 1
              ? resolve(
                  msg(
                    "{count, plural, one {{count} account · pooled} other {{count} accounts · pooled}}",
                    {
                      count: pool.accounts.length,
                    },
                  ),
                )
              : resolve(msg("Subscription remaining")),
          expiresAt: fresh ? expiresAt : 0,
          totalWindows: fresh ? pool.windows.length : 0,
          windows: fresh
            ? selectedWindows.map((window) => ({
                kind: window.kind,
                label: window.label,
                remaining: Math.round(window.remainingPercent),
                reset: window.resets[0]
                  ? isUpcoming(window.resets[0])
                    ? resolve(msg("Next reset {time}", { time: resetTime(window.resets[0].at) }))
                    : resolve(msg("Reset {time}", { time: resetTime(window.resets[0].at) }))
                  : resolve(msg("Reset time unavailable")),
                accounts: widgetAccounts(window, resolve),
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
  resolve: MessageResolver = m,
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
  const props = subscriptionUsageProps(
    collectLimitAccounts(presentations),
    0,
    configuredDrivers,
    maxWindowsPerProvider,
    resolve,
  );
  return {
    ...props,
    url,
    // The Android widget counts hidden rows across providers, a note row included.
    text: subscriptionUsageText(
      resolve,
      props.providers.reduce((sum, provider) => sum + Math.max(1, provider.totalWindows), 0),
    ),
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
          ? {
              ...provider,
              detail: snapshot.text?.refresh ?? m(msg("Open {app} to refresh", { app: "T3" })),
              windows: [],
              totalWindows: 0,
            }
          : provider,
      ),
    },
  }));
}
