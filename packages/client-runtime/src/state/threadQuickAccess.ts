import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking, sortWorkingThreadsBySend } from "./threadInbox.ts";

export interface ThreadQuickAccessEntry {
  readonly thread: EnvironmentThreadShell;
  readonly working: boolean;
}

function recentTimestamp(thread: EnvironmentThreadShell): number {
  const timestamp = Date.parse(thread.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Working threads lead the rail; the newest remaining threads fill its bounded shortcuts. */
export function selectThreadQuickAccess(
  threads: readonly EnvironmentThreadShell[],
  limit = 3,
): readonly ThreadQuickAccessEntry[] {
  if (limit <= 0) return [];
  const eligible = threads.filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null,
  );
  const working = sortWorkingThreadsBySend(eligible.filter(isThreadWorking));
  const workingKeys = new Set(working.map((thread) => `${thread.environmentId}:${thread.id}`));
  const recent = eligible
    .filter((thread) => !workingKeys.has(`${thread.environmentId}:${thread.id}`))
    .toSorted(
      (left, right) =>
        recentTimestamp(right) - recentTimestamp(left) ||
        left.id.localeCompare(right.id) ||
        left.environmentId.localeCompare(right.environmentId),
    );
  return [
    ...working.map((thread) => ({ thread, working: true }) as const),
    ...recent.map((thread) => ({ thread, working: false }) as const),
  ].slice(0, limit);
}
