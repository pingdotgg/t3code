import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { ProjectId, type EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";

export type ArchivedThreadSortOrder = "newest" | "oldest";

export interface ArchivedThreadGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

function archiveTimestamp(thread: EnvironmentThreadShell): number {
  const timestamp = Date.parse(thread.archivedAt ?? thread.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function matchesQuery(value: string | null, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query) ?? false;
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
    const projectlessThreads: EnvironmentThreadShell[] = [];
    for (const thread of entry.snapshot.threads) {
      if (thread.archivedAt === null) {
        continue;
      }
      const scopedThread = scopeThreadShell(entry.environmentId, thread);
      if (thread.projectId === null) {
        projectlessThreads.push(scopedThread);
        continue;
      }
      const threads = threadsByProjectId.get(thread.projectId) ?? [];
      threads.push(scopedThread);
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

      const timestampOrder = input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
      groups.push({
        key: scopedProjectKey(project.environmentId, project.id),
        project,
        threads: Arr.sort(
          matchingThreads,
          Order.mapInput(
            Order.Struct({ timestamp: timestampOrder, title: Order.String, id: Order.String }),
            (thread: EnvironmentThreadShell) => ({
              timestamp: archiveTimestamp(thread),
              title: thread.title,
              id: thread.id,
            }),
          ),
        ),
      });
    }
    const matchingProjectlessThreads =
      query.length === 0 ||
      matchesQuery("No project", query) ||
      matchesQuery(environmentLabel, query)
        ? projectlessThreads
        : projectlessThreads.filter((thread) => matchesQuery(thread.title, query));
    const firstProjectlessThread = matchingProjectlessThreads[0];
    if (firstProjectlessThread) {
      const project = {
        environmentId: entry.environmentId,
        id: ProjectId.make(`projectless-${entry.environmentId}`),
        title: "No project",
        workspaceRoot: firstProjectlessThread.workspaceRoot ?? "",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: firstProjectlessThread.createdAt,
        updatedAt: firstProjectlessThread.updatedAt,
      } satisfies EnvironmentProject;
      groups.push({
        key: `projectless:${entry.environmentId}`,
        project,
        threads: Arr.sort(
          matchingProjectlessThreads,
          Order.mapInput(
            Order.Struct({
              timestamp: input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number,
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

  const timestampOrder = input.sortOrder === "newest" ? Order.flip(Order.Number) : Order.Number;
  return Arr.sort(
    groups,
    Order.mapInput(
      Order.Struct({ timestamp: timestampOrder, title: Order.String, key: Order.String }),
      (group: ArchivedThreadGroup) => ({
        timestamp: group.threads[0] ? archiveTimestamp(group.threads[0]) : 0,
        title: group.project.title,
        key: group.key,
      }),
    ),
  );
}
