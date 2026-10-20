import {
  type EnvironmentId,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "Combined usage across both allowances, not a third quota.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok and Composer use this first. Auto can use either pool.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Claude, GPT, and Gemini use this pool. Grok and Composer fall back here.",
  },
] as const;

export function cursorUsageWindowDetails(id: string) {
  return CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = `${provider.displayName ?? provider.instanceId} on ${presentation.entry.target.label}`;
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

/**
 * Pass every enabled login, read or not, so an unreadable workspace still
 * counts as one.
 */
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Redeeming through a hub also clears the routing cooldown that hub holds
    // for the account. Redeeming natively against the same subscription resets
    // it upstream but leaves the hub refusing to route to the account until
    // its own cooldown expires, so a hub target wins the redemption outright
    // while the displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const creditSource = creditSources.get(key);
    accounts.set(key, {
      ...previous,
      displayName: previous.displayName ?? next.displayName,
      // The hub's generic Claude label carries no tier information.
      plan:
        winner.driver === "claudeAgent" && winner.plan === "Claude Subscription"
          ? ((fresher ? previous.plan : next.plan) ?? winner.plan)
          : winner.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`, {
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const key = `${source.id}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(resolveKey(account) ?? key, {
          key,
          driver: account.driver,
          displayName: account.email ? null : account.id.replace(/\.json$/i, ""),
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.push(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.push(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.push(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
    }
  }
  return notices;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    (LimitPoolMember | { readonly account: LimitAccount; readonly window: null }) & {
      readonly weight: number;
    }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver === "antigravity") {
    return [...pool.windows].sort(
      (left, right) =>
        Number(!left.id.startsWith("gemini-")) - Number(!right.id.startsWith("gemini-")) ||
        left.id
          .replace(/-(5h|weekly|quota)$/, "")
          .localeCompare(right.id.replace(/-(5h|weekly|quota)$/, "")) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hasBothPools = hasAuto && hasApi;
  return pool.windows
    .filter((window) => !hasBothPools || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? resetMillis(poolMember(account, window, now).window) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    if (account.plan === "ChatGPT Plus Subscription") return 1;
    const match = account.plan?.match(/^ChatGPT Pro (5|20)x Subscription$/);
    return match ? Number(match[1]) : undefined;
  }
  // Claude's published Max multipliers describe session allowance only.
  if (account.driver === "claudeAgent" && kind === "session") {
    const plan = account.plan?.replace(/^Claude (.+) Subscription$/, "$1");
    if (plan === "Pro") return 1;
    const match = plan?.match(/^Max (5|20)x$/);
    return match ? Number(match[1]) : undefined;
  }
  return undefined;
}

/**
 * Codex ids are slots, not allowances: a weekly-only plan reports its weekly
 * window as `primary`, other plans as `secondary`. Its windows pool by kind;
 * other drivers' ids name distinct allowances.
 */
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number) {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.usedPercent >= 100 &&
            (account.driver === "claudeAgent"
              ? window.id === "seven_day"
              : account.driver === "codex" && window.kind === "weekly"),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable.
  if (
    weeklyReset !== null &&
    sessionReset !== null &&
    weeklyReset > cutoff &&
    sessionReset > cutoff
  ) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, reportedMembers]): LimitPoolWindow => {
    const first = reportedMembers[0]!.window;
    // An unknown reporting capacity makes the whole window incomparable by plan.
    const weighted = reportedMembers.every(
      (member) => planCapacity(member.account, first.kind) !== undefined,
    );
    const weightOf = (account: LimitAccount) =>
      weighted ? (planCapacity(account, first.kind) ?? 1) : 1;
    const members = reportedMembers.map((member) => ({
      ...member,
      weight: weightOf(member.account),
    }));
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const totalWeight = members.reduce((sum, m) => sum + m.weight, 0);
    const usedPercent =
      members.reduce((sum, m) => sum + m.window.usedPercent * m.weight, 0) / totalWeight;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    // Pace compares spend against the clock, so it is judged only over the
    // members that have a clock; a window with no reset would otherwise
    // count as spend with no time elapsed and skew the verdict.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null
        ? []
        : [{ used: m.window.usedPercent, elapsed: share, weight: m.weight }];
    });
    const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
    const timedUsed = timed.reduce((sum, t) => sum + t.used * t.weight, 0) / timedWeight;
    const meanElapsed =
      timed.length > 0
        ? timed.reduce((sum, t) => sum + t.elapsed * t.weight, 0) / timedWeight
        : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round((member.refillPercent * member.weight) / totalWeight),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) =>
          memberByAccount.get(account.key) ?? { account, window: null, weight: weightOf(account) },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return "resets now";
  if (resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  return providers.map((provider) => {
    if (!hasProviderUsageLimits(provider.driver, providers, sources)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (provider.driver !== selected.driver || !provider.usageLimits) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = resolveKey(nativeReport(provider)) ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${account.id}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
