import type { EnvironmentId } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPresentations,
  type LimitPoolWindow,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";

import type {
  AndroidSubscriptionUsageSnapshot,
  SubscriptionUsageSnapshot,
} from "./subscriptionUsageTypes";
import type {
  SubscriptionWidgetConfiguration,
  SubscriptionWidgetPreferences,
} from "./subscriptionWidgetPreferences";

type WidgetPresentations = ReadonlyMap<
  EnvironmentId,
  NonNullable<ReturnType<LimitPresentations["get"]>> & {
    readonly connection: { readonly phase: string };
  }
>;

export type { AndroidSubscriptionUsageSnapshot } from "./subscriptionUsageTypes";

const MAX_AGE = 15 * 60_000;
const KIND_ORDER = { session: 0, weekly: 1, monthly: 2, other: 3 };

/** Device-local selection survives deduplication across environments; never published to the OS. */
export function subscriptionWidgetAccountId(account: LimitAccount) {
  return account.subscriptionKey ?? account.key;
}

function collectWidgetGroups(
  presentations: WidgetPresentations,
  configuration: SubscriptionWidgetConfiguration,
) {
  const showEnvironment =
    configuration.showEnvironment === "auto"
      ? [...presentations.values()].filter((value) => value.connection.phase === "connected")
          .length > 1
      : configuration.showEnvironment;
  const selected = new Map(
    [...presentations].filter(
      ([id]) => configuration.environmentIds === null || configuration.environmentIds.includes(id),
    ),
  );
  const allAccounts = collectLimitAccounts(selected).filter(
    (account) =>
      (account.driver === "codex" || account.driver === "claudeAgent") &&
      configuration.providers.includes(account.driver === "codex" ? "codex" : "claudeAgent"),
  );
  const accounts = allAccounts.filter(
    (account) =>
      configuration.accountIds === null ||
      configuration.accountIds.includes(subscriptionWidgetAccountId(account)),
  );
  const pools =
    configuration.grouping === "pooled"
      ? collectLimitPools(accounts, 0)
      : accounts.flatMap((account) => collectLimitPools([account], 0));
  const groups = pools.map((pool) => {
    const providerName = pool.driver === "codex" ? "Codex" : "Claude";
    const account = pool.accounts[0]!;
    const index = allAccounts
      .filter((candidate) => candidate.driver === pool.driver)
      .indexOf(account);
    const accountName = account.displayName ?? `Account ${index + 1}`;
    const period = pool.driver === "codex" ? configuration.codexPeriod : configuration.claudePeriod;
    const windows = pool.windows
      .filter((window) => period === "all" || period === "tightest" || window.kind === period)
      .sort((a, b) =>
        period === "tightest"
          ? a.remainingPercent - b.remainingPercent
          : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label),
      );
    const limit = period === "tightest" ? 1 : configuration.windowsPerAccount || Infinity;
    const environments = [
      ...new Set(pool.accounts.flatMap((a) => a.environments.map((e) => e.label))),
    ];
    const detail = [
      configuration.grouping === "pooled"
        ? `${pool.accounts.length} ${pool.accounts.length === 1 ? "account" : "accounts"} · pooled`
        : null,
      showEnvironment ? environments.join(", ") || account.sourceLabel : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      id: configuration.grouping === "pooled" ? pool.driver : `${pool.driver}:${index}`,
      name: configuration.grouping === "pooled" ? providerName : `${providerName} · ${accountName}`,
      detail: windows.length === 0 ? `No ${period} limit reported` : detail,
      windows: windows.slice(0, limit).map((window) => {
        const preferenceId = JSON.stringify([
          configuration.grouping === "pooled" ? pool.driver : subscriptionWidgetAccountId(account),
          window.kind,
          window.id,
        ]);
        return {
          preferenceId,
          id: `${window.kind}:${window.id}`,
          label: window.label,
          remaining: window.remainingPercent,
          reset: formatReset(window),
          resetsAt: window.resets[0]?.at ?? null,
          resetDisplay:
            configuration.quotaResetDisplays[preferenceId] ?? configuration.resetDisplay,
          expiresAt: windowExpiry(window),
        };
      }),
      totalWindows: period === "tightest" ? Math.min(windows.length, 1) : windows.length,
      driver: pool.driver,
      remaining: Math.min(...windows.map((window) => window.remainingPercent)),
      resetAt: Math.min(...windows.flatMap((window) => window.resets.map((reset) => reset.at))),
    };
  });
  return { groups, accounts };
}

export function collectSubscriptionWidgetQuotas(
  presentations: WidgetPresentations,
  configuration: SubscriptionWidgetConfiguration,
) {
  return collectWidgetGroups(presentations, configuration).groups.flatMap((group) =>
    group.windows.map((window) => ({
      id: window.preferenceId,
      account: group.name,
      label: window.label,
    })),
  );
}

export function buildAndroidSubscriptionUsageSnapshot(
  presentations: WidgetPresentations,
  configuration: SubscriptionWidgetConfiguration,
): AndroidSubscriptionUsageSnapshot {
  const { groups, accounts } = collectWidgetGroups(presentations, configuration);
  groups.sort((a, b) => {
    switch (configuration.sort) {
      case "name":
        return a.name.localeCompare(b.name);
      case "remaining":
        return a.remaining - b.remaining || a.name.localeCompare(b.name);
      case "reset":
        return a.resetAt - b.resetAt || a.name.localeCompare(b.name);
      default:
        return (
          configuration.providers.indexOf(a.driver === "codex" ? "codex" : "claudeAgent") -
            configuration.providers.indexOf(b.driver === "codex" ? "codex" : "claudeAgent") ||
          a.name.localeCompare(b.name)
        );
    }
  });
  const checked = accounts.map((account) => Date.parse(account.limits.checkedAt));
  return {
    configuration: {
      density: configuration.density,
      theme: configuration.theme,
      percentage: configuration.percentage,
      showBars: configuration.showBars,
      showResetTimes: configuration.showResetTimes,
      showUpdatedAt: configuration.showUpdatedAt,
    },
    checkedAt: checked.length > 0 && checked.every(Number.isFinite) ? Math.min(...checked) : 0,
    groups: groups.map(
      ({ driver: _driver, remaining: _remaining, resetAt: _resetAt, ...group }) => ({
        ...group,
        windows: group.windows.map(({ preferenceId: _preferenceId, ...window }) => window),
      }),
    ),
    emptyMessage:
      configuration.providers.length === 0 ||
      configuration.accountIds?.length === 0 ||
      configuration.environmentIds?.length === 0
        ? "No accounts selected. Configure in T3."
        : "No limits available for the selected accounts. Open T3 to refresh.",
  };
}

/** Refresh countdown text while readings are fresh, using the existing non-wakeup alarm. */
export function androidWidgetRefreshDeadlines(snapshot: SubscriptionUsageSnapshot, now: number) {
  const entries = snapshot.android
    ? [snapshot.android.defaults, ...Object.values(snapshot.android.widgets)]
    : [];
  const deadlines = new Set(snapshot.providers.map((provider) => provider.expiresAt));
  for (const entry of entries) {
    for (const window of entry.groups.flatMap((group) => group.windows)) {
      deadlines.add(window.expiresAt);
      if (
        !entry.configuration.showResetTimes ||
        window.resetDisplay === "reset" ||
        !window.resetsAt
      )
        continue;
      const until = Math.min(window.expiresAt, window.resetsAt, now + MAX_AGE);
      for (let at = (Math.floor(now / 60_000) + 1) * 60_000; at < until; at += 60_000) {
        deadlines.add(at);
      }
    }
  }
  return [...deadlines].filter((at) => at > now).sort((a, b) => a - b);
}

function formatReset(window: LimitPoolWindow) {
  return window.resets[0]
    ? `Next reset ${new Date(window.resets[0].at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : "Reset time unavailable";
}

function windowExpiry(window: LimitPoolWindow) {
  const deadline = Math.min(
    ...window.members.map((member) => Date.parse(member.account.limits.checkedAt) + MAX_AGE),
    ...window.resets.map((reset) => reset.at),
  );
  return Number.isFinite(deadline) ? deadline : 0;
}

export function withAndroidWidgetSnapshots(
  snapshot: SubscriptionUsageSnapshot,
  presentations: WidgetPresentations,
  preferences: SubscriptionWidgetPreferences,
): SubscriptionUsageSnapshot {
  return {
    ...snapshot,
    android: {
      defaults: buildAndroidSubscriptionUsageSnapshot(presentations, preferences.defaults),
      widgets: Object.fromEntries(
        Object.entries(preferences.widgets).map(([id, configuration]) => [
          id,
          buildAndroidSubscriptionUsageSnapshot(presentations, configuration),
        ]),
      ),
    },
  };
}
