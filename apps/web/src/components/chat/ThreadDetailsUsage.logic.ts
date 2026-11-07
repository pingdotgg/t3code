import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  environmentAccountKeyResolver,
  limitsNotice,
} from "@t3tools/shared/usageLimits";

export interface ThreadDetailsLimits {
  readonly limits: ServerProviderUsageLimits;
  /** The usage hub that reported these limits, when the instance could not read its own. */
  readonly sourceLabel: string | null;
}

/**
 * The limits the thread details card shows for one provider instance: the hub account that served
 * the thread's session (Thread accounts), even over the instance's own signed-in login; else the
 * instance's own limits; else the only hub account for the driver, since with several nothing says
 * which one the thread spends.
 */
export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
  providerSessionId: string | null = null,
): ThreadDetailsLimits | null {
  if (providerInstanceId === null) return null;
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  const report = collectProviderUsageLimits(providerInstanceId, providers, sources, now);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const routed =
    provider && providerSessionId
      ? routedHubAccount(provider, sources, providerSessionId)
      : undefined;
  // The tooltip names only the hub: account emails stay redacted, as in Usage → Limits.
  if (routed) return { limits: routed.account.usageLimits, sourceLabel: routed.source.label };

  const own =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    provider?.usageLimits;
  if (own && limitsNotice(own) === null) return { limits: own, sourceLabel: null };
  const hub = provider ? onlyHubAccount(provider, providers, sources) : null;
  if (hub) return { limits: hub.account.usageLimits, sourceLabel: hub.source.label };
  return own ? { limits: own, sourceLabel: null } : null;
}

interface HubAccount {
  readonly source: UsageLimitSourceSnapshot;
  readonly account: UsageLimitSourceAccount;
}

/**
 * The hub account a hub last routed this provider session to, when it shares that routing.
 * Only the driver must match: the hub served the session with this account, whatever login the
 * instance itself is signed in to.
 */
function routedHubAccount(
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
  providerSessionId: string,
): HubAccount | undefined {
  const matches = sources
    .flatMap((source) => source.accounts.map((account) => ({ source, account })))
    .filter(
      ({ account }) =>
        account.driver === provider.driver && account.sessionIds?.includes(providerSessionId),
    );
  // Two hubs both routed it (a moved base URL, chained hubs): nothing says which is current.
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The one hub account serving a driver, if its limits are usable. Unreadable accounts still count,
 * since the hub may route the thread through them. An account is a login (driver + email, else
 * credential) plus workspace: one login from two hubs is one account, its freshest snapshot wins.
 */
function onlyHubAccount(
  provider: ServerProvider,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): HubAccount | null {
  // A hub that failed to read may hold accounts for this driver too.
  if (sources.some((source) => source.error !== undefined)) return null;
  const candidates = sources.flatMap((source) =>
    source.accounts
      .filter((account) => canServeInstance(provider, account))
      .map((account) => ({ source, account })),
  );
  // Learn workspaces from every report, so an account without one never merges into one of several.
  const resolveKey = environmentAccountKeyResolver(providers, sources);
  const [only, ...rest] = freshestPerAccount(candidates, resolveKey);
  if (!only || rest.length > 0) return null;
  // A login seen in several workspaces, reported without one, may be another workspace's account.
  if (hasLogin(only.account) && resolveKey(only.account) === null) return null;
  return limitsNotice(only.account.usageLimits) === null ? only : null;
}

/** One entry per account key, keeping its most recently checked snapshot. */
function freshestPerAccount(
  candidates: readonly HubAccount[],
  resolveKey: (account: UsageLimitSourceAccount) => string | null,
): HubAccount[] {
  const freshestByAccount = new Map<string, HubAccount>();
  for (const candidate of candidates) {
    const key = resolveKey(candidate.account) ?? `${candidate.source.id}:${candidate.account.id}`;
    const known = freshestByAccount.get(key);
    if (!known || checkedAtMs(candidate) > checkedAtMs(known)) {
      freshestByAccount.set(key, candidate);
    }
  }
  return [...freshestByAccount.values()];
}

const hasLogin = (account: UsageLimitSourceAccount) =>
  normalizeEmail(account.email) !== undefined ||
  account.usageLimits.credentialFingerprint !== undefined;

const checkedAtMs = ({ account }: HubAccount) => Date.parse(account.usageLimits.checkedAt);

const normalizeEmail = (email: string | undefined) => email?.trim().toLowerCase() || undefined;

/** A hub account for the instance's driver, unless both sides name a different login or workspace. */
function canServeInstance(provider: ServerProvider, account: UsageLimitSourceAccount): boolean {
  if (account.driver !== provider.driver) return false;
  const instanceEmail = normalizeEmail(provider.auth.email);
  const hubEmail = normalizeEmail(account.email);
  if (instanceEmail && hubEmail && instanceEmail !== hubEmail) return false;
  const instanceWorkspace = provider.auth.workspaceId;
  return !instanceWorkspace || !account.workspaceId || instanceWorkspace === account.workspaceId;
}
