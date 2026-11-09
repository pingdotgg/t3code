import { isListedThreadLineage, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/** Picker rows for a task's destination: the current thread first, then the rest newest first. */
export function scheduledTaskDestinationRows(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId | null;
    readonly projectId: string | null;
    readonly current: { readonly id: ThreadId; readonly title: string } | null;
    readonly query: string;
  },
): ReadonlyArray<{ readonly id: ThreadId; readonly title: string }> {
  const search = target.query.trim().toLocaleLowerCase();
  const others = threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.current?.id &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({ id: thread.id, title: thread.title.trim() || "Untitled thread" }));
  return target.current !== null && target.current.title.toLocaleLowerCase().includes(search)
    ? [target.current, ...others]
    : others;
}
