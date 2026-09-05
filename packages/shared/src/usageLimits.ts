/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
import {
  type EnvironmentId,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderResetCredits,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Banked reset credits become urgent enough to call out one week before expiry. */
export const RESET_CREDIT_EXPIRY_WARNING_MS = 7 * DAY;
/** Let connected environments finish publishing before aggregating a launch reminder. */
export const RESET_CREDIT_REMINDER_SETTLE_GRACE_MS = 30_000;
/** Debounce adjacent presentation updates after the environments have settled. */
export const RESET_CREDIT_REMINDER_STABILIZE_MS = 1_000;

export interface ResetCreditExpiryWarning {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
  readonly availableCount: number;
  readonly expiresAt: string;
  readonly remainingMs: number;
}

export interface ResetCreditExpiryWarningView {
  readonly title: string;
  readonly description: string;
}

/**
 * Providers that belong on the Limits view: enabled, installed, and one whose
 * driver reports subscription usage at all. A driver with no notion of usage
 * never sets `usageLimits`, so it has no row rather than an empty one.
 */
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

export interface LimitsGroup {
  readonly environmentId: EnvironmentId;
  /** Null while only one environment is connected; there is nothing to tell apart. */
  readonly environmentLabel: string | null;
  readonly providers: readonly ServerProvider[];
}

type LimitsPresentationMap = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: { readonly providers: readonly ServerProvider[] } | null;
  }
>;

/**
 * One group per connected environment with a provider reporting limits.
 * Provider snapshots come from the config stream every client already holds,
 * so opening the view costs no extra request.
 */
export function collectLimitsGroups(presentations: LimitsPresentationMap): readonly LimitsGroup[] {
  const groups: LimitsGroup[] = [];
  for (const [environmentId, presentation] of presentations) {
    const providers = providersWithLimits(presentation.serverConfig?.providers ?? []);
    if (providers.length === 0) continue;
    groups.push({ environmentId, environmentLabel: presentation.entry.target.label, providers });
  }
  return groups.length > 1 ? groups : groups.map((group) => ({ ...group, environmentLabel: null }));
}

/**
 * Banked credits whose soonest expiry falls within the warning window. Native
 * provider rows are the source of truth because usage-limit hubs do not expose
 * reset credits. The same signed-in account is reported once across connected
 * environments when its email is known.
 */
export function collectResetCreditExpiryWarnings(
  presentations: LimitsPresentationMap,
  now: number,
  warningWindowMs = RESET_CREDIT_EXPIRY_WARNING_MS,
): readonly ResetCreditExpiryWarning[] {
  const warningsByAccount = new Map<string, ResetCreditExpiryWarning>();

  for (const [environmentId, presentation] of presentations) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const credits = provider.usageLimits?.resetCredits;
      const remainingMs = resetCreditExpiryRemainingMs(credits, now, warningWindowMs);
      if (credits === undefined || remainingMs === null || credits.nextExpiresAt === undefined) {
        continue;
      }
      const normalizedEmail = provider.auth.email?.trim().toLowerCase();
      const accountIdentity = normalizedEmail
        ? `${provider.driver}:${normalizedEmail}`
        : `${environmentId}:${provider.instanceId}`;
      const key = `${accountIdentity}:${credits.nextExpiresAt}`;
      const warning = {
        key,
        environmentId,
        environmentLabel: presentation.entry.target.label,
        provider,
        availableCount: credits.availableCount,
        expiresAt: credits.nextExpiresAt,
        remainingMs,
      } satisfies ResetCreditExpiryWarning;
      const existing = warningsByAccount.get(accountIdentity);
      if (existing === undefined || warning.remainingMs < existing.remainingMs) {
        warningsByAccount.set(accountIdentity, warning);
      }
    }
  }

  // Sort a copy rather than using ES2023 `toSorted`, which Hermes does not provide.
  return [...warningsByAccount.values()].sort(
    (left, right) => left.remainingMs - right.remainingMs || left.key.localeCompare(right.key),
  );
}

/** Remaining time only while an available banked credit is close enough to warn about. */
export function resetCreditExpiryRemainingMs(
  credits: ServerProviderResetCredits | undefined,
  now: number,
  warningWindowMs = RESET_CREDIT_EXPIRY_WARNING_MS,
): number | null {
  if (credits === undefined || credits.availableCount <= 0 || credits.nextExpiresAt === undefined) {
    return null;
  }
  const expiresAt = Date.parse(credits.nextExpiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  const remainingMs = expiresAt - now;
  return remainingMs > 0 && remainingMs <= warningWindowMs ? remainingMs : null;
}

/** Stable for one set of account/expiry pairs, independent of countdown changes. */
export function resetCreditExpiryNotificationKey(
  warnings: readonly ResetCreditExpiryWarning[],
): string | null {
  return warnings.length > 0 ? JSON.stringify(warnings.map((warning) => warning.key).sort()) : null;
}

/** Shared web/mobile wording for the reminder shown before a banked credit expires. */
export function resetCreditExpiryWarningView(
  warnings: readonly ResetCreditExpiryWarning[],
  driverLabel: (driver: ServerProvider["driver"]) => string | undefined,
): ResetCreditExpiryWarningView | null {
  const soonest = warnings[0];
  if (soonest === undefined) return null;
  if (warnings.length > 1) {
    return {
      title: "Reset credits expire soon",
      description: `${warnings.length} provider accounts have reset credits expiring within seven days. The soonest expires in ${formatDuration(soonest.remainingMs)}. Open Usage → Limits to review them.`,
    };
  }
  const providerLabel = providerLimitsLabel(soonest.provider, driverLabel);
  const credit =
    soonest.availableCount === 1
      ? "Your banked reset credit"
      : `One of your ${soonest.availableCount} banked reset credits`;
  return {
    title: `${providerLabel} reset credit expires soon`,
    description: `${credit} on ${soonest.environmentLabel} expires in ${formatDuration(soonest.remainingMs)}. Open Usage → Limits to use it before then.`,
  };
}

/**
 * Every usage-limit source across connected environments, keyed so two
 * environments pointing at the same hub still get their own rows. The label
 * carries the environment only when more than one environment has sources.
 * A native provider with usable limits takes precedence over the same account
 * in a source, even when it belongs to another connected environment.
 */
export function collectLimitSources(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: {
        readonly providers?: readonly ServerProvider[] | undefined;
        readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      } | null;
    }
  >,
): ReadonlyArray<
  UsageLimitSourceSnapshot & {
    readonly key: string;
    readonly environmentId: EnvironmentId;
    readonly hiddenAccountCount: number;
  }
> {
  const nativeAccounts = new Set<string>();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const key = accountKey(provider.driver, provider.auth.email);
      if (
        key !== null &&
        provider.usageLimits?.windows.length &&
        !provider.usageLimits.unavailable
      ) {
        nativeAccounts.add(key);
      }
    }
  }
  const perEnvironment: Array<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly sources: UsageLimitSourceSnapshots;
  }> = [];
  for (const [environmentId, presentation] of presentations) {
    const sources = presentation.serverConfig?.usageLimitSources ?? [];
    if (sources.length === 0) continue;
    perEnvironment.push({
      environmentId,
      environmentLabel: presentation.entry.target.label,
      sources,
    });
  }
  const labelEnvironment = perEnvironment.length > 1;
  return perEnvironment.flatMap(({ environmentId, environmentLabel, sources }) =>
    sources.map((source) => {
      const accounts = source.accounts.filter((account) => {
        const key = accountKey(account.driver, account.email);
        return key === null || !nativeAccounts.has(key);
      });
      return {
        ...source,
        accounts,
        hiddenAccountCount: source.accounts.length - accounts.length,
        environmentId,
        key: `${environmentId}:${source.id}`,
        label: labelEnvironment ? `${environmentLabel} · ${source.label}` : source.label,
      };
    }),
  );
}

function accountKey(driver: ServerProvider["driver"], email: string | undefined): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  return normalizedEmail ? `${driver}:${normalizedEmail}` : null;
}

/** The instance's configured name, else the driver's, else its raw kind. */
export function providerLimitsLabel(
  provider: ServerProvider,
  driverLabel: (driver: ServerProvider["driver"]) => string | undefined,
): string {
  return provider.displayName?.trim() || driverLabel(provider.driver) || String(provider.driver);
}

/** The one-line status under a provider heading when there are no bars to draw. */
export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. The bar is the whole window, so the elapsed share
 * is also where even spending would have put the fill; within five points of
 * it counts as on pace.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  return resetsAt <= now ? "resets now" : `resets in ${formatDuration(resetsAt - now)}`;
}
