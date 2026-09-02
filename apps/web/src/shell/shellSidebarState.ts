import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ShellSidebarDraft,
  ShellSidebarState,
  ShellSidebarThread,
} from "@t3tools/contracts/shell";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  type SidebarThreadPartition,
} from "../components/Sidebar.logic";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

/** Settled rows beyond this are summarised by `settledTotal`. */
export const SHELL_SIDEBAR_SETTLED_LIMIT = 50;

export interface ShellSidebarStateInput {
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly scopeProjectKey: string | null;
  readonly partition: SidebarThreadPartition;
  readonly threadCountByLogicalKey: ReadonlyMap<string, number>;
  readonly lastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly drafts: ReadonlyArray<ShellSidebarDraft>;
  readonly activeThreadKey: string | null;
  readonly activeDraftId: string | null;
}

/** `<environmentId>:<projectId>` → logical project key, from the grouped snapshots. */
export function buildLogicalProjectKeyMap(
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of projectGroups) {
    for (const ref of group.memberProjectRefs) {
      map.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  return map;
}

function toShellThread(
  thread: EnvironmentThreadShell,
  logicalKeyByPhysicalKey: ReadonlyMap<string, string>,
  lastVisitedAtByKey: Readonly<Record<string, string | undefined>>,
): ShellSidebarThread {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const lastVisitedAt = lastVisitedAtByKey[key];
  const statusInput = { ...thread, lastVisitedAt };
  return {
    key,
    threadId: thread.id,
    environmentId: thread.environmentId,
    projectKey:
      logicalKeyByPhysicalKey.get(`${thread.environmentId}:${thread.projectId}`) ??
      `${thread.environmentId}:${thread.projectId}`,
    title: thread.title,
    status: resolveSidebarThreadStatus(thread),
    statusLabel: resolveThreadStatusPill({ thread: statusInput })?.label ?? null,
    unread: hasUnseenCompletion(statusInput),
    branch: thread.branch,
    updatedAt: thread.updatedAt,
    pinned: thread.pinnedAt != null,
    snoozedUntil: thread.snoozedUntil ?? null,
  };
}

export function buildShellSidebarState(input: ShellSidebarStateInput): ShellSidebarState {
  const logicalKeyByPhysicalKey = buildLogicalProjectKeyMap(input.projectGroups);
  const convert = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
    threads.map((thread) =>
      toShellThread(thread, logicalKeyByPhysicalKey, input.lastVisitedAtByKey),
    );
  return {
    projects: input.projectGroups.map((group) => ({
      key: group.projectKey,
      displayName: group.displayName,
      environmentId: group.environmentId,
      projectId: group.id,
      workspaceRoot: group.workspaceRoot,
      threadCount: input.threadCountByLogicalKey.get(group.projectKey) ?? 0,
    })),
    scopeProjectKey: input.scopeProjectKey,
    pinned: convert(input.partition.pinnedThreads),
    active: convert(input.partition.activeThreads),
    snoozed: convert(input.partition.snoozedThreads),
    settled: convert(input.partition.settledThreads.slice(0, SHELL_SIDEBAR_SETTLED_LIMIT)),
    settledTotal: input.partition.settledThreads.length,
    drafts: input.drafts,
    activeThreadKey: input.activeThreadKey,
    activeDraftId: input.activeDraftId,
  };
}
