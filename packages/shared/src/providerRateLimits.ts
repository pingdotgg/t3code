/**
 * Provider usage-limit helpers shared by the server (auto-switch) and the
 * clients (switch suggestion). Both sides must agree on what "limited right
 * now" means and which sibling account can take over a thread.
 *
 * @module providerRateLimits
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderRateLimit,
} from "@t3tools/contracts";

export type RateLimitFallbackCandidate = Pick<
  ServerProvider,
  | "instanceId"
  | "driver"
  | "displayName"
  | "continuation"
  | "enabled"
  | "installed"
  | "status"
  | "availability"
  | "rateLimit"
>;

/**
 * A limit is active while the provider reported `rejected` and the reset time
 * is unknown or still ahead. Once `resetsAt` passes the stale state no longer
 * blocks anything, so the client can rely on this without a server round trip.
 */
export function isProviderRateLimitActive(
  rateLimit: ServerProviderRateLimit | undefined,
  nowMs: number,
): boolean {
  if (!rateLimit || rateLimit.status !== "rejected") return false;
  if (rateLimit.resetsAt === undefined) return true;
  const resetsAtMs = Date.parse(rateLimit.resetsAt);
  return !Number.isFinite(resetsAtMs) || resetsAtMs > nowMs;
}

/**
 * Pick another configured account that can continue a thread bound to
 * `instanceId`: same driver, same continuation group, usable, and not limited
 * itself. Ties break toward the account with the most headroom.
 */
export function selectRateLimitFallbackProvider<
  Candidate extends RateLimitFallbackCandidate,
>(input: {
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
    if (isProviderRateLimitActive(candidate.rateLimit, input.nowMs)) continue;
    if (best === null || utilizationOf(candidate) < utilizationOf(best)) {
      best = candidate;
    }
  }
  return best;
}

function utilizationOf(candidate: RateLimitFallbackCandidate): number {
  return candidate.rateLimit?.utilization ?? 0;
}
