import { type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";

interface ProviderFallbackChainState {
  readonly attemptedInstanceIds: Set<ProviderInstanceId>;
  activeInstanceId: ProviderInstanceId;
}

const PROVIDER_FALLBACK_CHAIN_CAPACITY = 10_000;
const providerFallbackChains = new Map<ThreadId, ProviderFallbackChainState>();

function makeRoomForProviderFallbackChain(): void {
  if (providerFallbackChains.size < PROVIDER_FALLBACK_CHAIN_CAPACITY) return;
  const oldestThreadId = providerFallbackChains.keys().next().value;
  if (oldestThreadId !== undefined) {
    providerFallbackChains.delete(oldestThreadId);
  }
}

/**
 * Starts a new chain or resumes the chain owned by the failing instance.
 * Returning a copy prevents callers from mutating the tracked chain.
 */
export function beginProviderFallbackChain(
  threadId: ThreadId,
  failedInstanceId: ProviderInstanceId,
): ReadonlySet<ProviderInstanceId> {
  const existing = providerFallbackChains.get(threadId);
  if (existing?.activeInstanceId === failedInstanceId) {
    existing.attemptedInstanceIds.add(failedInstanceId);
    return new Set(existing.attemptedInstanceIds);
  }

  makeRoomForProviderFallbackChain();
  const attemptedInstanceIds = new Set([failedInstanceId]);
  providerFallbackChains.set(threadId, {
    attemptedInstanceIds,
    activeInstanceId: failedInstanceId,
  });
  return new Set(attemptedInstanceIds);
}

export function markProviderFallbackInstanceAttempted(
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
): void {
  const state = providerFallbackChains.get(threadId);
  if (!state) return;
  state.attemptedInstanceIds.add(instanceId);
  state.activeInstanceId = instanceId;
}

export function completeProviderFallbackChain(
  threadId: ThreadId,
  activeInstanceId?: ProviderInstanceId,
): void {
  const state = providerFallbackChains.get(threadId);
  if (!state || (activeInstanceId !== undefined && state.activeInstanceId !== activeInstanceId)) {
    return;
  }
  providerFallbackChains.delete(threadId);
}

export function resetProviderFallbackChainsForTest(): void {
  providerFallbackChains.clear();
}
