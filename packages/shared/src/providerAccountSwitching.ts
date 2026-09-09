/**
 * Choosing another account to continue a thread on when the one it is bound
 * to has run out of subscription usage.
 *
 * Reads the usage windows the provider already publishes on its snapshot
 * (`ServerProvider.usageLimits`), so there is no second notion of "limited"
 * anywhere: the server auto-switch and the client's switch offer agree by
 * construction.
 *
 * @module providerAccountSwitching
 */
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { ProviderInstanceId } from "@t3tools/contracts";

export type AccountSwitchCandidate = Pick<
  ServerProvider,
  | "instanceId"
  | "driver"
  | "displayName"
  | "continuation"
  | "enabled"
  | "installed"
  | "status"
  | "availability"
  | "usageLimits"
>;

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * The window that is out of quota and has not reopened yet, or null when the
 * account can still run turns. When several are spent, the one reopening
 * soonest is the one that decides when work can continue; a window whose
 * reset the provider never named sorts last because it promises nothing.
 */
export function exhaustedUsageWindow(
  provider: Pick<AccountSwitchCandidate, "usageLimits">,
  nowMs: number,
): ServerProviderUsageWindow | null {
  const spent = (provider.usageLimits?.windows ?? []).filter((window) => {
    if (window.usedPercent < 100) return false;
    const resetsAt = resetMillis(window);
    return resetsAt === null || resetsAt > nowMs;
  });
  if (spent.length === 0) return null;
  return spent.reduce((soonest, window) => {
    const a = resetMillis(soonest);
    const b = resetMillis(window);
    if (b === null) return soonest;
    if (a === null) return window;
    return b < a ? window : soonest;
  });
}

export function isProviderOutOfUsage(
  provider: Pick<AccountSwitchCandidate, "usageLimits">,
  nowMs: number,
): boolean {
  return exhaustedUsageWindow(provider, nowMs) !== null;
}

/** Highest share of any window this account has spent, for ranking siblings. */
function peakUsedPercent(provider: Pick<AccountSwitchCandidate, "usageLimits">): number {
  return (provider.usageLimits?.windows ?? []).reduce(
    (peak, window) => Math.max(peak, window.usedPercent),
    0,
  );
}

/**
 * Pick another configured account that can continue a thread bound to
 * `instanceId`: same driver, same continuation group, usable, and with usage
 * left. Ties break toward the account with the most headroom.
 */
export function selectAccountSwitchTarget<Candidate extends AccountSwitchCandidate>(input: {
  readonly providers: ReadonlyArray<Candidate>;
  readonly instanceId: ProviderInstanceId;
  readonly nowMs: number;
}): Candidate | null {
  const current = input.providers.find((provider) => provider.instanceId === input.instanceId);
  if (!current) return null;
  const currentGroupKey = current.continuation?.groupKey;
  // No continuation group means the snapshot predates instance identity;
  // there is no way to know its session store is shared.
  if (currentGroupKey === undefined) return null;

  let best: Candidate | null = null;
  for (const candidate of input.providers) {
    if (candidate.instanceId === current.instanceId) continue;
    if (candidate.driver !== current.driver) continue;
    if (candidate.continuation?.groupKey !== currentGroupKey) continue;
    if (!candidate.enabled) continue;
    if (candidate.installed === false) continue;
    if (candidate.availability === "unavailable") continue;
    if (candidate.status === "error" || candidate.status === "disabled") continue;
    if (isProviderOutOfUsage(candidate, input.nowMs)) continue;
    if (best === null || peakUsedPercent(candidate) < peakUsedPercent(best)) {
      best = candidate;
    }
  }
  return best;
}
