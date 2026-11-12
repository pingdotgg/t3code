import { isListedThread, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

type DestinationCandidate = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "updatedAt"
  | "archivedAt"
  | "lineage"
  | "parentThreadId"
  | "parentRelationship"
>;

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads<T extends DestinationCandidate>(
  threads: ReadonlyArray<T>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<T> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThread(thread) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
