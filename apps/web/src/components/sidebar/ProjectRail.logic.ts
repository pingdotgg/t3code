import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import { orderItemsByPreferredIds, resolveSidebarFolderDot } from "../Sidebar.logic";

export type ProjectRailDot = ReturnType<typeof resolveSidebarFolderDot>;

type RailGroup = Pick<
  SidebarProjectSnapshot,
  "projectKey" | "memberProjects" | "memberProjectRefs"
>;

type RailThread = Parameters<typeof resolveSidebarFolderDot>[0][number] &
  Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "pinnedAt" | "settledOverride" | "snoozedUntil"
  >;

/**
 * The rail keeps the manual project order whatever the sidebar sort is, so a
 * tile stays where it was dragged. Projects never ordered keep their input order
 * after the ordered ones.
 */
export function orderProjectRailGroups<TGroup extends RailGroup>(
  groups: readonly TGroup[],
  projectOrder: readonly string[],
): TGroup[] {
  return orderItemsByPreferredIds({
    items: groups,
    preferredIds: projectOrder,
    getId: (group) => group.projectKey,
    getPreferenceIds: (group) => [
      ...group.memberProjects.map((member) => member.physicalProjectKey),
      ...group.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
    ],
  });
}

/** The manual project order after `activeKey` is dropped onto `overKey`'s place. */
export function projectOrderAfterRailMove(
  orderedGroups: readonly RailGroup[],
  activeKey: string,
  overKey: string,
): string[] | null {
  const from = orderedGroups.findIndex((group) => group.projectKey === activeKey);
  const to = orderedGroups.findIndex((group) => group.projectKey === overKey);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...orderedGroups];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.flatMap((group) => group.memberProjects.map((member) => member.physicalProjectKey));
}

/**
 * A plain click shows only that project, or every project when it was already
 * the only one shown. An additive click adds or removes it.
 */
export function nextProjectRailScope(
  current: readonly string[],
  key: string,
  additive: boolean,
): string[] {
  if (additive) {
    return current.includes(key)
      ? current.filter((candidate) => candidate !== key)
      : [...current, key];
  }
  return current.length === 1 && current[0] === key ? [] : [key];
}

export interface ProjectRailTileState {
  readonly dot: ProjectRailDot;
  /** No thread outside the settled and snoozed shelves, and nothing to show on the dot. */
  readonly idle: boolean;
}

export function resolveProjectRailTileStates(
  groups: readonly RailGroup[],
  threads: readonly RailThread[],
  now: string,
): Map<string, ProjectRailTileState> {
  const groupKeyByProject = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByProject.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  const threadsByGroup = new Map<string, RailThread[]>();
  for (const thread of threads) {
    const groupKey = groupKeyByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (groupKey === undefined) continue;
    const list = threadsByGroup.get(groupKey);
    if (list) list.push(thread);
    else threadsByGroup.set(groupKey, [thread]);
  }
  const states = new Map<string, ProjectRailTileState>();
  for (const group of groups) {
    const groupThreads = threadsByGroup.get(group.projectKey) ?? [];
    const dot = resolveSidebarFolderDot(groupThreads);
    const live = groupThreads.some(
      (thread) =>
        thread.pinnedAt != null ||
        (thread.settledOverride !== "settled" && !effectiveSnoozed(thread, { now })),
    );
    states.set(group.projectKey, { dot, idle: dot === null && !live });
  }
  return states;
}
