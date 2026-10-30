import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits, limitsNotice } from "@t3tools/shared/usageLimits";

export interface ThreadDetailsLimits {
  readonly limits: ServerProviderUsageLimits;
  /** The usage hub that reported these limits, when the instance could not read its own. */
  readonly sourceLabel: string | null;
}

/**
 * The limits the thread details card shows for one provider instance.
 * An instance routed through a usage hub (CLIProxyAPI) reads no subscription limits of its own,
 * so the card falls back to the hub, but only when exactly one hub account serves the driver:
 * with several, nothing says which one this thread spends.
 */
export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  if (providerInstanceId === null) return null;
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  const report = collectProviderUsageLimits(providerInstanceId, providers, sources, now);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    provider?.usageLimits;
  if (own && limitsNotice(own) === null) return { limits: own, sourceLabel: null };

  const hubAccounts = provider
    ? sources.flatMap((source) =>
        source.accounts
          .filter(
            (account) =>
              account.driver === provider.driver && limitsNotice(account.usageLimits) === null,
          )
          .map((account) => ({ source, account })),
      )
    : [];
  const [onlyHubAccount] = hubAccounts;
  if (hubAccounts.length === 1 && onlyHubAccount) {
    return { limits: onlyHubAccount.account.usageLimits, sourceLabel: onlyHubAccount.source.label };
  }
  return own ? { limits: own, sourceLabel: null } : null;
}
