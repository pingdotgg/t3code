import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";

export type ArchivedThreadSortOrder = "newest" | "oldest";

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

function parseTimestamp(input: string): number | null {
  const timestamp = Date.parse(input);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function archiveTimestamp(thread: EnvironmentThreadShell): number | null {
  return parseTimestamp(thread.archivedAt ?? thread.updatedAt);
}

export function formatArchivedThreadRelativeTime(input: string): string | null {
  return parseTimestamp(input) === null ? null : relativeTime(input);
}

function matchesQuery(value: string | null, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

function makeArchiveTimestampOrder(sortOrder: ArchivedThreadSortOrder): Order.Order<number | null> {
  const timestampOrder = sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
  return Order.make((left, right) => {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return timestampOrder(left, right);
  });
}

export function buildArchivedThreadGroups(input: {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly environmentLabels: Readonly<Record<string, string>>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly sortOrder: ArchivedThreadSortOrder;
}): ReadonlyArray<ArchivedThreadGroup> {
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const groups: ArchivedThreadGroup[] = [];

  for (const entry of input.snapshots) {
    if (input.environmentId !== null && input.environmentId !== entry.environmentId) {
      continue;
    }

    const environmentLabel = input.environmentLabels[entry.environmentId] ?? null;
    const threadsByProjectId = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of entry.snapshot.threads) {
      if (thread.archivedAt === null) {
        continue;
      }
      const threads = threadsByProjectId.get(thread.projectId) ?? [];
      threads.push(scopeThreadShell(entry.environmentId, thread));
      threadsByProjectId.set(thread.projectId, threads);
    }

    for (const rawProject of entry.snapshot.projects) {
      const project = scopeProject(entry.environmentId, rawProject);
      const projectThreads = threadsByProjectId.get(project.id) ?? [];
      const groupMatches =
        query.length === 0 ||
        matchesQuery(project.title, query) ||
        matchesQuery(project.workspaceRoot, query) ||
        matchesQuery(environmentLabel, query);
      const matchingThreads = groupMatches
        ? projectThreads
        : projectThreads.filter(
            (thread) => matchesQuery(thread.title, query) || matchesQuery(thread.branch, query),
          );

      if (matchingThreads.length === 0) {
        continue;
      }

      const timestampOrder = makeArchiveTimestampOrder(input.sortOrder);
      groups.push({
        key: scopedProjectKey(project.environmentId, project.id),
        project,
        threads: Arr.sort(
          matchingThreads,
          Order.mapInput(
            Order.Struct({
              timestamp: timestampOrder,
              title: Order.String,
              id: Order.String,
            }),
            (thread: EnvironmentThreadShell) => ({
              timestamp: archiveTimestamp(thread),
              title: thread.title,
              id: thread.id,
            }),
          ),
        ),
      });
    }
  }

  const timestampOrder = makeArchiveTimestampOrder(input.sortOrder);
  return Arr.sort(
    groups,
    Order.mapInput(
      Order.Struct({ timestamp: timestampOrder, title: Order.String, key: Order.String }),
      (group: ArchivedThreadGroup) => ({
        timestamp: group.threads[0] ? archiveTimestamp(group.threads[0]) : null,
        title: group.project.title,
        key: group.key,
      }),
    ),
  );
}
