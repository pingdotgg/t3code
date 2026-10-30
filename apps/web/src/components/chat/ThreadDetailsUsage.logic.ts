import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { accountKey, collectProviderUsageLimits, limitsNotice } from "@t3tools/shared/usageLimits";

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

type SourceAccount = UsageLimitSourceSnapshot["accounts"][number];

interface HubAccount {
  readonly source: UsageLimitSourceSnapshot;
  readonly account: SourceAccount;
}

/**
 * The one usable hub account serving a driver, or null when none or several do.
 * An account is its login (driver + email, else credential) and workspace, so one login reported by
 * two hubs is one account and its freshest snapshot wins; two workspaces stay two accounts.
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
  const freshestByAccount = new Map<string, HubAccount>();
  for (const candidate of candidates) {
    const key = hubAccountKey(candidate);
    const known = freshestByAccount.get(key);
    if (!known || checkedAtMs(candidate) > checkedAtMs(known)) {
      freshestByAccount.set(key, candidate);
    }
  }
  const [only, ...rest] = freshestByAccount.values();
  return only && rest.length === 0 ? only : null;
}

function hubAccountKey({ source, account }: HubAccount): string {
  const login = accountKey(account.driver, account.email, account.usageLimits);
  if (!login) return `${source.id}:${account.id}`;
  return account.workspaceId ? `${login}:${account.workspaceId}` : login;
}

const checkedAtMs = ({ account }: HubAccount) => Date.parse(account.usageLimits.checkedAt);

const normalizeEmail = (email: string | undefined) => email?.trim().toLowerCase() || undefined;

/** A usable hub account for the instance's driver, unless both sides name different logins. */
function canServeInstance(provider: ServerProvider, account: SourceAccount): boolean {
  if (account.driver !== provider.driver || limitsNotice(account.usageLimits) !== null) {
    return false;
  }
  const own = normalizeEmail(provider.auth.email);
  const hub = normalizeEmail(account.email);
  return !own || !hub || own === hub;
}
