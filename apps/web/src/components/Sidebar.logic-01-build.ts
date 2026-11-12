import { THREAD_JUMP_HINT_SHOW_DELAY_MS, filterSidebarV2VisibleThreads } from "./Sidebar.logic-02-should.ts";
import type { LogicalSidebarProject, ScopedSidebarProject, ScopedSidebarThread, SidebarProject, ThreadStatusInput, ThreadStatusPill, ThreadTraversalDirection } from "./Sidebar.logic-02-should.ts";
import type { SidebarProjectScopeMenuAction, SidebarProjectScopeMenuState, SidebarThreadStatus, SidebarThreadStatusInput } from "./Sidebar.logic-03-sidebar.ts";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  threadSearchMatchKey,
  threadSearchSubject,
  type ThreadSearchShell,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import {
  isListedThreadLineage,
  type ContextMenuItem,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  planPinnedReorder,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary, Thread } from "../types";
import { normalizeSearchText } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";
import { deadlineAfter, deadlineStore } from "@t3tools/client-runtime/clock";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { legacyProjectCwdPreferenceKey } from "../uiStateStore";

export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export function useThreadJumpHintsVisible(shouldShow: boolean): boolean {
  const [showAt, setShowAt] = React.useState<number | null>(null);
  // The clock is read inside the updater: the compiler caches a bare clock read
  // in render once per instance, so a second hold would reuse the first deadline.
  // React discards this render and re-runs with the update.
  if (shouldShow !== (showAt !== null)) {
    setShowAt(shouldShow ? () => deadlineAfter(THREAD_JUMP_HINT_SHOW_DELAY_MS) : null);
  }
  return useDeadlinePassed(showAt);
}

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // Server visits override local watermarks, including mark-unread rewinds; use local values only on older
  // servers.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
export function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

// Suppress trailing double-click navigation; keyboard and synthetic clicks use detail 0.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

/** The "New thread in" picker opens unless there is one open project or none; then the current context decides. */
export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  openProjectGroupCount: number,
  projectGroupCount: number,
): boolean {
  return shiftKey || openProjectGroupCount === 1 || projectGroupCount === 0;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (
    input.isActive ||
    input.isSelected ||
    input.status === "input" ||
    input.status === "request"
  ) {
    return false;
  }
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/**
 * The dot on a closed boring-sidebar folder: the most urgent state among its
 * hidden threads. Waiting threads stay quiet, like their rows.
 */
export function resolveSidebarFolderDot(
  threads: ReadonlyArray<ThreadStatusInput & SidebarThreadStatusInput>,
): "attention" | "failed" | "unread" | "working" | null {
  const statuses = new Set(threads.map(resolveSidebarThreadStatus));
  if (
    statuses.has("input") ||
    statuses.has("approval") ||
    statuses.has("request") ||
    statuses.has("limited")
  ) {
    return "attention";
  }
  if (statuses.has("failed")) return "failed";
  // Rows show Done only for ready threads, so the dot follows the same rule.
  const hasUnread = threads.some(
    (thread) => resolveSidebarThreadStatus(thread) === "ready" && hasUnseenCompletion(thread),
  );
  if (hasUnread) return "unread";
  if (statuses.has("working")) return "working";
  return null;
}

/**
 * Keys the old per-project sidebar saved folder open state under, most
 * specific first, for `resolveProjectExpanded`. Boring folders read and write
 * the same keys, so a legacy user's closed folders stay closed after regrouping.
 */
export function sidebarFolderExpansionKeys(group: {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly physicalProjectKey: string;
    readonly workspaceRoot: string;
  }>;
}): string[] {
  return [
    group.projectKey,
    ...group.memberProjects.map((member) => member.physicalProjectKey),
    ...group.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

/**
 * Boring sidebar folders. Folders follow `groups` order and threads keep their
 * input order. A project with no threads gets a folder only when `keepEmpty` says so.
 * A thread whose project is in no group has no folder and is left out.
 */
export function groupSidebarThreadsByProject<
  TGroup extends {
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: string;
    }>;
  },
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "projectId">,
>(
  groups: readonly TGroup[],
  threads: readonly TThread[],
  keepEmpty: (group: TGroup) => boolean,
): Array<{ group: TGroup; threads: TThread[] }> {
  const folders = groups.map((group) => ({ group, threads: [] as TThread[] }));
  const folderByProject = new Map<string, (typeof folders)[number]>();
  for (const folder of folders) {
    for (const ref of folder.group.memberProjectRefs) {
      folderByProject.set(`${ref.environmentId}:${ref.projectId}`, folder);
    }
  }
  for (const thread of threads) {
    folderByProject.get(`${thread.environmentId}:${thread.projectId}`)?.threads.push(thread);
  }
  return folders.filter((folder) => folder.threads.length > 0 || keepEmpty(folder.group));
}

export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
export {
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";

export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

export const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Sidebar search results: title, branch, and pull request matches ranked as
 * the command palette ranks them, then threads listed only because their
 * messages match, in `contentMatchKeys` order.
 */
export function searchSidebarThreads<
  T extends ThreadSearchShell & {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  },
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
  now = Date.now(),
): { readonly titleMatches: T[]; readonly contentMatches: T[] } {
  const normalizedQuery = foldSearchQuery(query);
  if (normalizedQuery.length === 0) return { titleMatches: [], contentMatches: [] };
  const titleMatches = rankSearchItems(threads, (thread, options) =>
    scoreThreadSearch(normalizedQuery, threadSearchSubject(thread, null), now, {
      ...options,
      picks: false,
    }),
  ).map(({ item }) => item);
  const listed = new Set(titleMatches);
  // In the order the server ranked their messages, as the palette lists them.
  const threadByKey = new Map(
    threads.map((thread) => [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  const contentMatches = [...contentMatchKeys].flatMap((key) => {
    const thread = threadByKey.get(key);
    return thread && !listed.has(thread) ? [thread] : [];
  });
  return { titleMatches, contentMatches };
}

export function pullRequestMatchesSearchQuery(
  pullRequest: Parameters<typeof threadPullRequestSearchTerms>[0],
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return false;
  const haystack = normalizeSearchText(threadPullRequestSearchTerms(pullRequest).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return {
      label: "Guest Request",
      colorClass: "text-guest-foreground",
      dotClass: "bg-guest",
      pulse: false,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt" | "settledOverride"> &
    ThreadSortInput &
    ThreadSnoozeShell,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  now: string;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, now, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id) &&
          thread.settledOverride !== "settled" &&
          !effectiveSnoozed(thread, { now }),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Project timestamps scan all threads; compute once per project instead of per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread &
    Pick<SidebarThreadSummary, "environmentId" | "id" | "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
  delegatedUnderParent: ReadonlySet<string>,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent),
    sortOrder,
  );
}

export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}

