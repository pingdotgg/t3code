/**
 * Thread eviction policy for renderer memory management.
 *
 * Decides which threads should have their heavy data (messages, activities,
 * proposedPlans, turnDiffSummaries) dropped from the Zustand store.
 * Sidebar metadata is always retained.
 */

/** How many fully-hydrated threads to keep in memory at once. */
export const EVICTION_KEEP_COUNT = 5;

export interface EvictableThread {
  id: string;
  hydrated: boolean;
  isActive: boolean;
  hasRunningSession: boolean;
  updatedAt: string;
  messageCount: number;
  activityCount: number;
}

/**
 * Returns the IDs of threads that should be evicted (dehydrated).
 * Never evicts: the active thread, threads with running sessions,
 * or already-dehydrated threads.
 */
export function selectThreadsToEvict(
  threads: ReadonlyArray<EvictableThread>,
  activeThreadId: string | null,
): string[] {
  const evictable = threads.filter(
    (t) => t.hydrated && !t.isActive && t.id !== activeThreadId && !t.hasRunningSession,
  );

  const hydratedCount = threads.filter((t) => t.hydrated).length;

  if (hydratedCount <= EVICTION_KEEP_COUNT) {
    return [];
  }

  const toEvictCount = hydratedCount - EVICTION_KEEP_COUNT;

  // Sort by updatedAt ascending — oldest idle threads get evicted first
  const sorted = evictable.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return sorted.slice(0, toEvictCount).map((t) => t.id);
}
