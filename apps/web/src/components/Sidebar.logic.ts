import * as React from "react";
import type { ThreadId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  buildGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
} from "@t3tools/shared/githubPullRequest";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
export type SidebarThreadListMode = "grouped" | "recent";
export type RecentSidebarBucketId = "today" | "yesterday" | "week" | "earlier";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

export interface SidebarPullRequestReference {
  url: string;
  owner: string;
  repo: string;
  number: string;
}

export type SidebarReferencedPullRequestState = "open" | "closed" | "merged" | null;
export interface RecentSidebarBucket<T> {
  id: RecentSidebarBucketId;
  label: string;
  threads: readonly T[];
}

type ThreadPullRequestReferenceInput = Pick<Thread, "messages">;

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

const GITHUB_PULL_REQUEST_URL_GLOBAL_PATTERN = /https:\/\/github\.com\/[^\s)\]}>]+/gi;

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveThreadSidebarRepositoryCwds(input: {
  worktreePath?: string | null;
  projectCwd?: string | null;
}): string[] {
  const candidates = [input.worktreePath, input.projectCwd];
  return [
    ...new Set(
      candidates.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0),
    ),
  ];
}

export function deriveThreadSidebarPullRequestReferences(
  thread: ThreadPullRequestReferenceInput,
): SidebarPullRequestReference[] {
  const references = new Map<string, SidebarPullRequestReference>();

  for (const message of thread.messages) {
    for (const match of message.text.matchAll(GITHUB_PULL_REQUEST_URL_GLOBAL_PATTERN)) {
      const rawUrl = match[0];
      if (!rawUrl) {
        continue;
      }
      const parsed = parseGitHubPullRequestUrl(rawUrl);
      if (!parsed) {
        continue;
      }
      const normalizedUrl = buildGitHubPullRequestUrl(parsed);
      if (references.has(normalizedUrl)) {
        continue;
      }
      references.set(normalizedUrl, {
        url: normalizedUrl,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
      });
    }
  }

  return [...references.values()];
}

export function formatSidebarPullRequestBadgeLabel(input: { number: string }): string {
  return `#${input.number}`;
}

export function referencedPrPillClassName(state: SidebarReferencedPullRequestState): string {
  if (state === "open") {
    return "border-emerald-200/90 bg-emerald-50 text-emerald-700 hover:bg-emerald-100/90 hover:text-emerald-800 dark:border-emerald-500/25 dark:bg-emerald-500/12 dark:text-emerald-300";
  }
  if (state === "merged") {
    return "border-violet-200/90 bg-violet-50 text-violet-700 hover:bg-violet-100/90 hover:text-violet-800 dark:border-violet-500/25 dark:bg-violet-500/12 dark:text-violet-300";
  }
  if (state === "closed") {
    return "border-rose-200/90 bg-rose-50 text-rose-700 hover:bg-rose-100/90 hover:text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/12 dark:text-rose-300";
  }
  return "border-border/70 bg-secondary/75 text-muted-foreground/88 hover:bg-accent hover:text-foreground";
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function sortThreadsForRecentSidebar<T extends Pick<Thread, "id"> & ThreadSortInput>(
  threads: readonly T[],
): T[] {
  return sortThreads(threads, "updated_at");
}

const RECENT_SIDEBAR_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_SIDEBAR_BUCKET_LABELS: Record<RecentSidebarBucketId, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Earlier this week",
  earlier: "Older",
};

function resolveRecentSidebarBucketId(timestampMs: number, nowMs: number): RecentSidebarBucketId {
  if (!Number.isFinite(timestampMs)) {
    return "earlier";
  }
  const diffMs = nowMs - timestampMs;
  if (diffMs < RECENT_SIDEBAR_DAY_MS) {
    return "today";
  }
  if (diffMs < 2 * RECENT_SIDEBAR_DAY_MS) {
    return "yesterday";
  }
  if (diffMs < 7 * RECENT_SIDEBAR_DAY_MS) {
    return "week";
  }
  return "earlier";
}

export function bucketRecentThreadsForSidebar<T extends Pick<Thread, "id"> & ThreadSortInput>(
  threads: readonly T[],
  nowMs = Date.now(),
): RecentSidebarBucket<T>[] {
  const buckets = new Map<RecentSidebarBucketId, T[]>([
    ["today", []],
    ["yesterday", []],
    ["week", []],
    ["earlier", []],
  ]);

  for (const thread of sortThreadsForRecentSidebar(threads)) {
    const bucketId = resolveRecentSidebarBucketId(
      getThreadSortTimestamp(thread, "updated_at"),
      nowMs,
    );
    buckets.get(bucketId)?.push(thread);
  }

  return (["today", "yesterday", "week", "earlier"] as const).reduce<RecentSidebarBucket<T>[]>(
    (result, bucketId) => {
      const bucketThreads = buckets.get(bucketId) ?? [];
      if (bucketThreads.length === 0) {
        return result;
      }
      result.push({
        id: bucketId,
        label: RECENT_SIDEBAR_BUCKET_LABELS[bucketId],
        threads: bucketThreads,
      });
      return result;
    },
    [],
  );
}

export function visibleRecentThreadsForSidebar<
  T extends Pick<Thread, "id"> & ThreadSortInput,
>(input: { threads: readonly T[]; isExpanded: boolean; threadPreviewLimit: number }): T[] {
  const orderedThreads = sortThreadsForRecentSidebar(input.threads);
  if (orderedThreads.length <= input.threadPreviewLimit || input.isExpanded) {
    return orderedThreads;
  }
  return orderedThreads.slice(0, input.threadPreviewLimit);
}

export function visibleThreadIdsForRecentSidebar<
  T extends Pick<Thread, "id"> & ThreadSortInput,
>(input: { threads: readonly T[]; isExpanded: boolean; threadPreviewLimit: number }): ThreadId[] {
  return visibleRecentThreadsForSidebar(input).map((thread) => thread.id);
}

export function deriveSidebarThreadProjectName(input: {
  thread: Pick<SidebarThreadSummary, "projectId">;
  projects: readonly Pick<SidebarProject, "id" | "name">[];
}): string | null {
  return input.projects.find((project) => project.id === input.thread.projectId)?.name ?? null;
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
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

export function resolveSidebarProjectNavigationTarget<TProjectKey, TThreadKey>(input: {
  projects: readonly {
    projectKey: TProjectKey;
    threadKeys: readonly TThreadKey[];
  }[];
  currentProjectKey: TProjectKey | null;
  currentThreadKey: TThreadKey | null;
  direction: ThreadTraversalDirection;
}): { projectKey: TProjectKey; threadKey: TThreadKey } | null {
  const navigableProjects = input.projects.filter((project) => project.threadKeys.length > 0);
  if (navigableProjects.length === 0) {
    return null;
  }

  const inferredCurrentProjectKey =
    input.currentProjectKey ??
    navigableProjects.find((project) =>
      input.currentThreadKey === null ? false : project.threadKeys.includes(input.currentThreadKey),
    )?.projectKey ??
    null;

  if (inferredCurrentProjectKey === null) {
    const fallbackProject =
      input.direction === "previous" ? navigableProjects.at(-1) : navigableProjects[0];
    const fallbackThreadKey = fallbackProject?.threadKeys[0];
    return fallbackProject && fallbackThreadKey
      ? { projectKey: fallbackProject.projectKey, threadKey: fallbackThreadKey }
      : null;
  }

  const currentProjectIndex = navigableProjects.findIndex(
    (project) => project.projectKey === inferredCurrentProjectKey,
  );
  if (currentProjectIndex === -1) {
    return null;
  }

  const targetProjectIndex =
    input.direction === "previous" ? currentProjectIndex - 1 : currentProjectIndex + 1;
  const targetProject = navigableProjects[targetProjectIndex];
  const targetThreadKey = targetProject?.threadKeys[0];
  return targetProject && targetThreadKey
    ? { projectKey: targetProject.projectKey, threadKey: targetThreadKey }
    : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
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

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
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
          !deletedThreadIds?.has(thread.id),
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

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
