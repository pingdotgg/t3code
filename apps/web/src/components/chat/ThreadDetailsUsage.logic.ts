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
  hubRoutes,
  instanceHubs,
  type LimitPoolWindow,
  limitsNotice,
} from "@t3tools/shared/usageLimits";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "pool"; readonly windows: readonly LimitPoolWindow[] };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits;
  if (!own) return null;
  const hubs = instanceHubs(provider, sources);
  if (limitsNotice(own) === null || hubs.length === 0) return { kind: "instance", limits: own };
  // An instance sent to a hub reads no limits of its own; its hub pools the accounts it spends.
  return hubPool(provider.driver, model, providers, hubs, now) ?? { kind: "instance", limits: own };
}

export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

function hubPool(
  driver: ServerProvider["driver"],
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const routes = hubRoutes(sources, driver, model);
  const routed = sources.map((source) => ({ ...source, accounts: source.accounts.filter(routes) }));
  const readable = routed
    .flatMap((source) => source.accounts)
    .filter((account) => limitsNotice(account.usageLimits) === null);
  if (readable.length === 0) return null;
  // A signed-in login joins the pool only as a fresher reading of an account the hub routes to.
  const signedIn = providers.filter((provider) =>
    readable.some(
      (account) =>
        account.driver === provider.driver &&
        account.workspaceId === provider.auth.workspaceId &&
        account.email !== undefined &&
        account.email.toLowerCase() === provider.auth.email?.toLowerCase(),
    ),
  );
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: signedIn, usageLimitSources: routed },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools.length > 0 ? { kind: "pool", windows: pools.flatMap(displayLimitWindows) } : null;
}

export function poolSources(window: LimitPoolWindow): string[] {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return [...new Set(hubs), ...(signedIn ? ["Signed-in accounts"] : [])];
}
