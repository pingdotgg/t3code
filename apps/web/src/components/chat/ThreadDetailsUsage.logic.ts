import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  accountKeyResolver,
  collectProviderUsageLimits,
  limitsNotice,
} from "@t3tools/shared/usageLimits";

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

  const hub = provider ? onlyHubAccount(provider, sources) : null;
  if (hub) return { limits: hub.account.usageLimits, sourceLabel: hub.source.label };
  return own ? { limits: own, sourceLabel: null } : null;
}

interface HubAccount {
  readonly source: UsageLimitSourceSnapshot;
  readonly account: UsageLimitSourceAccount;
}

/**
 * The one hub account serving a driver, if its limits are usable. Unreadable accounts still count,
 * since the hub may route the thread through them. An account is a login (driver + email, else
 * credential) plus workspace: one login from two hubs is one account, its freshest snapshot wins.
 */
function onlyHubAccount(
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
): HubAccount | null {
  const candidates = sources.flatMap((source) =>
    source.accounts
      .filter((account) => canServeInstance(provider, account))
      .map((account) => ({ source, account })),
  );
  const resolveKey = accountKeyResolver(candidates.map(({ account }) => account));
  const freshestByAccount = new Map<string, HubAccount>();
  for (const candidate of candidates) {
    const key = resolveKey(candidate.account) ?? `${candidate.source.id}:${candidate.account.id}`;
    const known = freshestByAccount.get(key);
    if (!known || checkedAtMs(candidate) > checkedAtMs(known)) {
      freshestByAccount.set(key, candidate);
    }
  }
  const [only, ...rest] = freshestByAccount.values();
  if (!only || rest.length > 0) return null;
  return limitsNotice(only.account.usageLimits) === null ? only : null;
}

const checkedAtMs = ({ account }: HubAccount) => Date.parse(account.usageLimits.checkedAt);

const normalizeEmail = (email: string | undefined) => email?.trim().toLowerCase() || undefined;

/** A hub account for the instance's driver, unless both sides name different logins. */
function canServeInstance(provider: ServerProvider, account: UsageLimitSourceAccount): boolean {
  if (account.driver !== provider.driver) return false;
  const instanceEmail = normalizeEmail(provider.auth.email);
  const hubEmail = normalizeEmail(account.email);
  return !instanceEmail || !hubEmail || instanceEmail === hubEmail;
}
