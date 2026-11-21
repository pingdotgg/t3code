import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { isListedThreadLineage } from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";
import { threadKey } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { resolveThreadActivityTimestamp, toSortableTimestamp } from "./threadSort.ts";

/**
 * Tasks one parent thread the client cannot list delegated into one project of one
 * environment, so a list scoped to a project or environment holds whole groups. Lists show
 * one row for the parent in the place of `representativeKey`, its most relevant task.
 * Task keys are `scopedThreadKey`s, as list rows use.
 */
export interface DelegatedTaskGroup {
  readonly key: string;
  readonly parent: ScopedThreadRef;
  readonly title: string;
  /** The parent machine's label in the client's environment catalog, if it has one. */
  readonly environmentLabel: string | null;
  /** The most recently active unsettled task, or the most recently active one when all are settled. */
  readonly representativeKey: string;
  /** Most recently active first. */
  readonly taskKeys: ReadonlyArray<string>;
}

export interface DelegatedTaskGroups {
  readonly groups: ReadonlyArray<DelegatedTaskGroup>;
  readonly byRepresentativeKey: ReadonlyMap<string, DelegatedTaskGroup>;
  /** Grouped tasks other than representatives: they have no row of their own. */
  readonly foldedKeys: ReadonlySet<string>;
}

export const NO_DELEGATED_TASK_GROUPS: DelegatedTaskGroups = {
  groups: [],
  byRepresentativeKey: new Map(),
  foldedKeys: new Set(),
};

type GroupableThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "archivedAt"
  | "lineage"
  | "delegatedFrom"
  | "settledOverride"
  | "latestUserMessageAt"
  | "latestRun"
  | "updatedAt"
>;

/**
 * Groups the delegated tasks among `threads` that no listed parent shows by parent, then by
 * the environment and project they run in. A parent known to be archived leaves its tasks
 * listed on their own. Allocates nothing until it finds a task to group.
 */
export function groupDelegatedTasks(input: {
  readonly threads: ReadonlyArray<GroupableThread>;
  /** `threadKey`s of the tasks listed under their parent. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly isParentArchived: (parent: ScopedThreadRef) => boolean;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
}): DelegatedTaskGroups {
  let byGroup: Map<string, Array<{ key: string; thread: GroupableThread; at: number }>> | undefined;
  for (const thread of input.threads) {
    const from = thread.delegatedFrom;
    if (
      from == null ||
      thread.archivedAt !== null ||
      !isListedThreadLineage(thread.lineage) ||
      input.delegatedUnderParent.has(
        threadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    ) {
      continue;
    }
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    const groupKey = `${scopedThreadKey(from)}|${thread.environmentId}:${thread.projectId}`;
    byGroup ??= new Map();
    let tasks = byGroup.get(groupKey);
    if (tasks === undefined) {
      if (input.isParentArchived({ environmentId: from.environmentId, threadId: from.threadId })) {
        continue;
      }
      tasks = [];
      byGroup.set(groupKey, tasks);
    }
    const at = toSortableTimestamp(resolveThreadActivityTimestamp(thread) ?? undefined) ?? 0;
    tasks.push({ key, thread, at });
  }
  if (byGroup === undefined || byGroup.size === 0) return NO_DELEGATED_TASK_GROUPS;
  const groups: DelegatedTaskGroup[] = [];
  const byRepresentativeKey = new Map<string, DelegatedTaskGroup>();
  const foldedKeys = new Set<string>();
  for (const [key, tasks] of byGroup) {
    tasks.sort((left, right) => right.at - left.at || (left.key < right.key ? -1 : 1));
    const newest = tasks[0]!;
    const representative =
      tasks.find((task) => task.thread.settledOverride !== "settled") ?? newest;
    const from = newest.thread.delegatedFrom!;
    const group: DelegatedTaskGroup = {
      key,
      parent: { environmentId: from.environmentId, threadId: from.threadId },
      title: from.title,
      environmentLabel: input.environmentLabel(from.environmentId),
      representativeKey: representative.key,
      taskKeys: tasks.map((task) => task.key),
    };
    groups.push(group);
    byRepresentativeKey.set(representative.key, group);
    for (const task of tasks) if (task !== representative) foldedKeys.add(task.key);
  }
  return { groups, byRepresentativeKey, foldedKeys };
}

const sameGroup = (left: DelegatedTaskGroup, right: DelegatedTaskGroup) =>
  left.key === right.key &&
  left.title === right.title &&
  left.environmentLabel === right.environmentLabel &&
  left.representativeKey === right.representativeKey &&
  left.taskKeys.length === right.taskKeys.length &&
  left.taskKeys.every((taskKey, index) => taskKey === right.taskKeys[index]);

export function delegatedTaskGroupsEqual(
  left: DelegatedTaskGroups,
  right: DelegatedTaskGroups,
): boolean {
  return (
    left.groups.length === right.groups.length &&
    left.groups.every((group, index) => sameGroup(group, right.groups[index]!))
  );
}
