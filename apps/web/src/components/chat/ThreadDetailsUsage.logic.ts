import {
  EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  displayLimitWindows,
  type LimitPoolWindow,
  limitsNotice,
} from "@t3tools/shared/usageLimits";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "pool"; readonly windows: readonly LimitPoolWindow[] };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

/**
 * The limits the thread details card shows for one provider instance: its own, or, when it reads
 * none (as when it sends requests through a CLIProxyAPI hub), the pool of its driver's accounts.
 */
export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits;
  if (!own) return null;
  if (limitsNotice(own) === null) return { kind: "instance", limits: own };
  return driverPool(provider.driver, providers, sources, now) ?? { kind: "instance", limits: own };
}

/** The reset the card names: the soonest for one account, the soonest that refills quota for a pool. */
export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

function driverPool(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const hubReadsDriver = sources.some((source) =>
    source.accounts.some(
      (account) => account.driver === driver && limitsNotice(account.usageLimits) === null,
    ),
  );
  if (!hubReadsDriver) return null;
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers, usageLimitSources: sources },
      },
    ],
  ]);
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => account.driver === driver,
  );
  const [pool] = collectLimitPools(accounts, now);
  if (!pool) return null;
  return { kind: "pool", windows: displayLimitWindows(pool) };
}

/** Where a pooled window's readings come from: the hubs holding its hub-only accounts, then signed-in accounts. */
export function poolSources(window: LimitPoolWindow): string[] {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return [...new Set(hubs), ...(signedIn ? ["Signed-in accounts"] : [])];
}
