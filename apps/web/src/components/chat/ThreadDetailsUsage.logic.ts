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
  | {
      readonly kind: "hub";
      readonly windows: readonly LimitPoolWindow[];
      readonly hubLabels: readonly string[];
    };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

/**
 * The limits the thread details card shows for one provider instance: its own, or, when it reads
 * none (as when it sends requests through a CLIProxyAPI hub), the pool of its driver's hub accounts.
 * The hub picks an account per request, so a thread spends the pool rather than any one account.
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
  if (own && limitsNotice(own) === null) return { kind: "instance", limits: own };
  return hubPool(provider.driver, sources, now) ?? (own ? { kind: "instance", limits: own } : null);
}

function hubPool(
  driver: ServerProvider["driver"],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  // No native providers: a login outside the hubs is not one the hub can route a request to.
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: [], usageLimitSources: sources },
      },
    ],
  ]);
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => account.driver === driver,
  );
  const [pool] = collectLimitPools(accounts, now);
  if (!pool) return null;
  const hubLabels = sources
    .filter((source) =>
      source.accounts.some(
        (account) => account.driver === driver && limitsNotice(account.usageLimits) === null,
      ),
    )
    .map((source) => source.label);
  return { kind: "hub", windows: displayLimitWindows(pool), hubLabels };
}
