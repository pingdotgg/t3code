import { isListedThreadLineage, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/** Threads a task can move to, newest first. The current one is left out; pickers show it first. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId | null;
    readonly projectId: string | null;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
