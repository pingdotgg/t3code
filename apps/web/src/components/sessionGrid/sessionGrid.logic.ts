import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem } from "@t3tools/contracts";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  firstValidTimestampMs,
  parseTimestampMs,
  resolveThreadStatusPill,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "../Sidebar.logic";

export interface SessionGridSearch {
  readonly project?: string;
}

export type SessionGridChangeRequestState = ChangeRequestStateLike | null | "unknown";
export type SessionGridLifecycle = "active" | "snoozed" | "settled" | "archived";
export type SessionGridArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface SessionGridSection {
  readonly project: SidebarProjectSnapshot;
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly snoozedThreads: readonly EnvironmentThreadShell[];
  readonly threads: readonly EnvironmentThreadShell[];
}

export interface SessionGridDimensions {
  readonly columns: number;
  readonly rows: number;
}

export interface SessionGridProjectPanelEntry {
  readonly project: SidebarProjectSnapshot;
  readonly openThreads: readonly EnvironmentThreadShell[];
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly attentionCount: number;
}

export type SessionGridProjectContextAction =
  | "open-project"
  | "new-session"
  | "toggle-settled"
  | "remove-all"
  | `copy-path:${string}`
  | `remove:${string}`;

function gridProjectMemberLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) return member.title;
  return member.environmentLabel
    ? `${member.environmentLabel} — ${member.workspaceRoot}`
    : member.workspaceRoot;
}

/** Shared by right-click and the visible overflow button in the grid project navigator. */
export function buildSessionGridProjectContextMenuItems(input: {
  readonly project: SidebarProjectSnapshot;
  readonly settledCount: number;
  readonly settledExpanded: boolean;
}): readonly ContextMenuItem<SessionGridProjectContextAction>[] {
  const { project } = input;
  const copyPathItems = project.memberProjects.map(
    (member): ContextMenuItem<SessionGridProjectContextAction> => ({
      id: `copy-path:${member.physicalProjectKey}`,
      label: gridProjectMemberLabel(member, project.groupedProjectCount),
      icon: "copy",
    }),
  );
  const removeItems = project.memberProjects.map(
    (member): ContextMenuItem<SessionGridProjectContextAction> => ({
      id: `remove:${member.physicalProjectKey}`,
      label: gridProjectMemberLabel(member, project.groupedProjectCount),
      destructive: true,
      icon: "trash",
    }),
  );

  return [
    { id: "open-project", label: "Show project grid" },
    { id: "new-session", label: "New session" },
    ...(input.settledCount > 0
      ? [
          {
            id: "toggle-settled" as const,
            label: `${input.settledExpanded ? "Hide" : "Show"} settled sessions`,
          },
        ]
      : []),
    project.memberProjects.length === 1
      ? { ...copyPathItems[0]!, label: "Copy project path" }
      : { id: "copy-path:menu", label: "Copy project path", children: copyPathItems },
    project.memberProjects.length === 1
      ? { ...removeItems[0]!, label: "Remove project" }
      : {
          id: "remove:menu",
          label: "Remove project…",
          icon: "trash",
          children: [
            ...removeItems,
            {
              id: "remove-all",
              label: "All grouped entries",
              destructive: true,
              icon: "trash",
            },
          ],
        },
  ];
}

/**
 * Grid panes treat a completed turn as attention until that exact completion
 * has been viewed. Unlike the sidebar's historical-thread-safe unread model,
 * a missing visit timestamp is attention here: every pane in the live grid is
 * an explicitly unsettled work item and should be reviewed once before it can
 * visually recede.
 */
export function sessionGridCompletionNeedsAttention(input: {
  readonly completedAt: string | null | undefined;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  if (!input.completedAt) return false;
  const completedAtMs = Date.parse(input.completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!input.lastVisitedAt) return true;

  const lastVisitedAtMs = Date.parse(input.lastVisitedAt);
  return Number.isNaN(lastVisitedAtMs) || completedAtMs > lastVisitedAtMs;
}

/** Keep project rollups aligned with the activity treatment used by grid headers. */
export function sessionGridThreadNeedsAttention(input: {
  readonly thread: EnvironmentThreadShell;
  readonly lastVisitedAt: string | null | undefined;
}): boolean {
  const { thread, lastVisitedAt } = input;
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return true;

  const status = resolveThreadStatusPill({
    thread: { ...thread, lastVisitedAt: lastVisitedAt ?? undefined },
  });
  if (status) {
    return (
      status.label !== "Working" && status.label !== "Connecting" && status.label !== "Monitoring"
    );
  }

  return sessionGridCompletionNeedsAttention({
    completedAt: thread.latestTurn?.completedAt,
    lastVisitedAt,
  });
}

export function buildSessionGridProjectPanelEntries(input: {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly lifecycleByThreadKey: ReadonlyMap<string, SessionGridLifecycle>;
  readonly lastVisitedAtByThreadKey: Readonly<Record<string, string>>;
}): SessionGridProjectPanelEntry[] {
  const projectKeyByPhysicalKey = new Map(
    input.projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (member) =>
          [
            sessionGridPhysicalProjectKey({
              environmentId: member.environmentId,
              projectId: member.projectId,
            }),
            project.projectKey,
          ] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    const projectKey = projectKeyByPhysicalKey.get(
      sessionGridPhysicalProjectKey({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      }),
    );
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) existing.push(thread);
    else threadsByProjectKey.set(projectKey, [thread]);
  }

  return input.projects.map((project) => {
    const openThreads: EnvironmentThreadShell[] = [];
    const settledThreads: EnvironmentThreadShell[] = [];
    let attentionCount = 0;

    for (const thread of threadsByProjectKey.get(project.projectKey) ?? []) {
      const threadKey = `${thread.environmentId}:${thread.id}`;
      const lifecycle = input.lifecycleByThreadKey.get(threadKey);
      if (lifecycle === "settled") {
        settledThreads.push(thread);
        continue;
      }
      if (lifecycle !== "active" && lifecycle !== "snoozed") continue;
      openThreads.push(thread);
      if (
        lifecycle === "active" &&
        sessionGridThreadNeedsAttention({
          thread,
          lastVisitedAt: input.lastVisitedAtByThreadKey[threadKey],
        })
      ) {
        attentionCount++;
      }
    }

    return {
      project,
      openThreads: sortSessionGridThreads(openThreads),
      settledThreads: sortSettledThreadsForSidebar(settledThreads),
      attentionCount,
    };
  });
}

/** Match 2code's compact, near-square pane layout. */
export function resolveSessionGridDimensions(sessionCount: number): SessionGridDimensions {
  const count = Math.max(1, Math.floor(sessionCount));
  if (count === 1) return { columns: 1, rows: 1 };
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

/** Existing panes keep their position while removed panes disappear and new panes append. */
export function stabilizeSessionGridThreadKeys(
  preferredKeys: readonly string[],
  currentKeys: readonly string[],
): string[] {
  const currentKeySet = new Set(currentKeys);
  const result = preferredKeys.filter((key) => currentKeySet.has(key));
  const resultSet = new Set(result);
  for (const key of currentKeys) {
    if (!resultSet.has(key)) {
      result.push(key);
      resultSet.add(key);
    }
  }
  return result;
}

/** Keep URL state narrow and resilient to hand-edited or stale links. */
export function parseSessionGridSearch(search: Record<string, unknown>): SessionGridSearch {
  return typeof search.project === "string" && search.project.length > 0
    ? { project: search.project }
    : {};
}

export function resolveSessionGridProject(
  projects: readonly SidebarProjectSnapshot[],
  requestedProjectKey: string | null,
): SidebarProjectSnapshot | null {
  if (requestedProjectKey === null) return null;
  return projects.find((project) => project.projectKey === requestedProjectKey) ?? null;
}

/**
 * The grid is the visual twin of Sidebar v2's working partition. Snooze is
 * checked before pinning, and a pin keeps a thread active ahead of automatic
 * settlement. Unknown PR state fails visible while VCS metadata loads, but an
 * explicit settle can still hide immediately.
 */
export function resolveSessionGridLifecycle(
  thread: EnvironmentThreadShell,
  options: {
    readonly preciseNow: string;
    readonly settledNow: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge: boolean;
    readonly supportsSettlement: boolean;
    readonly supportsSnooze: boolean;
    readonly changeRequestState: SessionGridChangeRequestState;
  },
): SessionGridLifecycle {
  if (thread.archivedAt !== null) return "archived";

  if (options.supportsSnooze && effectiveSnoozed(thread, { now: options.preciseNow })) {
    return "snoozed";
  }

  if (thread.pinnedAt != null) return "active";
  if (!options.supportsSettlement) return "active";

  const changeRequestStateUnknown = options.changeRequestState === "unknown";
  return effectiveSettled(thread, {
    now: options.settledNow,
    // An unresolved branch query cannot safely auto-settle: it may reveal an
    // open PR, which blocks inactivity settlement. Explicit overrides remain
    // authoritative because effectiveSettled checks them before this window.
    autoSettleAfterDays: changeRequestStateUnknown ? null : options.autoSettleAfterDays,
    autoSettleOnMerge: options.autoSettleOnMerge,
    changeRequest:
      changeRequestStateUnknown || options.changeRequestState === null
        ? null
        : { state: options.changeRequestState },
  })
    ? "settled"
    : "active";
}

export function sessionGridPhysicalProjectKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return `${input.environmentId}:${input.projectId}`;
}

/** Branch-scoped so a merged PR result cannot hide a thread after it moves branches. */
export function sessionGridChangeRequestKey(input: {
  readonly threadKey: string;
  readonly branch: string | null;
}): string {
  return `${input.threadKey}\0${input.branch ?? ""}`;
}

/** A cached `null` is a resolved "no PR" result; only a missing key is unknown. */
export function resolveSessionGridChangeRequestState(
  states: ReadonlyMap<string, SessionGridChangeRequestState>,
  key: string,
  branch: string | null,
): SessionGridChangeRequestState {
  if (states.has(key)) return states.get(key) ?? null;
  return branch === null ? null : "unknown";
}

/** Provider errors retain these stable not-found phrases after RPC transport. */
export function isSessionGridMissingChangeRequestError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("pull request not found") ||
    (normalized.includes("merge request") && normalized.includes("was not found"))
  );
}

/**
 * Preserve the project row's spatial memory while shells update. Removed
 * projects disappear and newly-added projects append; existing blocks do not
 * jump merely because one of their agents emitted activity.
 */
export function stabilizeSessionGridProjectKeys(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
): string[] {
  const nextKeySet = new Set(nextKeys);
  const stableKeys = previousKeys.filter((key) => nextKeySet.has(key));
  const stableKeySet = new Set(stableKeys);
  for (const key of nextKeys) {
    if (!stableKeySet.has(key)) stableKeys.push(key);
  }
  return stableKeys;
}

export function resolveSessionGridArrowTargetIndex(input: {
  readonly key: SessionGridArrowKey;
  readonly currentIndex: number;
  readonly columnCount: number;
  readonly itemCount: number;
}): number | null {
  const columnCount = Math.max(1, input.columnCount);
  const column = input.currentIndex % columnCount;
  if (input.key === "ArrowLeft" && column === 0) return null;
  if (input.key === "ArrowRight" && column === columnCount - 1) return null;
  const offset =
    input.key === "ArrowLeft"
      ? -1
      : input.key === "ArrowRight"
        ? 1
        : input.key === "ArrowUp"
          ? -columnCount
          : columnCount;
  const targetIndex = input.currentIndex + offset;
  return targetIndex >= 0 && targetIndex < input.itemCount ? targetIndex : null;
}

export function sortSessionGridThreads(
  threads: readonly EnvironmentThreadShell[],
): EnvironmentThreadShell[] {
  const pinned = threads.filter((thread) => thread.pinnedAt != null);
  const unpinned = threads.filter((thread) => thread.pinnedAt == null);
  return [...sortThreadsForSidebar(pinned), ...sortThreadsForSidebar(unpinned)];
}

export function sortSessionGridSnoozedThreads(
  threads: readonly EnvironmentThreadShell[],
): EnvironmentThreadShell[] {
  return threads.toSorted(
    (left, right) =>
      firstValidTimestampMs(left.snoozedUntil ?? null) -
      firstValidTimestampMs(right.snoozedUntil ?? null),
  );
}

/**
 * Build one project grid without inventing a second project identity model.
 * A valid URL selection remains visible even when empty. With no selection,
 * choose the first project with unsettled work, then fall back to the first
 * project so /grid is immediately useful rather than becoming a dashboard.
 */
export function buildSessionGridSections(input: {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly snoozedThreads: readonly EnvironmentThreadShell[];
  readonly requestedProjectKey: string | null;
}): {
  readonly selectedProjectKey: string | null;
  readonly sections: readonly SessionGridSection[];
  readonly countsByProjectKey: ReadonlyMap<string, number>;
} {
  const logicalKeyByPhysicalProject = new Map(
    input.projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) =>
          [
            sessionGridPhysicalProjectKey({
              environmentId: ref.environmentId,
              projectId: ref.projectId,
            }),
            project.projectKey,
          ] as const,
      ),
    ),
  );
  const groupThreads = (threads: readonly EnvironmentThreadShell[]) => {
    const threadsByLogicalProject = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of threads) {
      const logicalKey = logicalKeyByPhysicalProject.get(
        sessionGridPhysicalProjectKey({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
        }),
      );
      if (!logicalKey) continue;
      const projectThreads = threadsByLogicalProject.get(logicalKey);
      if (projectThreads) projectThreads.push(thread);
      else threadsByLogicalProject.set(logicalKey, [thread]);
    }
    return threadsByLogicalProject;
  };
  const activeThreadsByLogicalProject = groupThreads(input.activeThreads);
  const snoozedThreadsByLogicalProject = groupThreads(input.snoozedThreads);
  const sections = input.projects.map((project): SessionGridSection => {
    const activeThreads = sortSessionGridThreads(
      activeThreadsByLogicalProject.get(project.projectKey) ?? [],
    );
    const snoozedThreads = sortSessionGridSnoozedThreads(
      snoozedThreadsByLogicalProject.get(project.projectKey) ?? [],
    );
    return {
      project,
      activeThreads,
      snoozedThreads,
      threads: [...activeThreads, ...snoozedThreads],
    };
  });
  const countsByProjectKey = new Map(
    sections.map((section) => [section.project.projectKey, section.threads.length] as const),
  );
  const selectedProjectKey =
    resolveSessionGridProject(input.projects, input.requestedProjectKey)?.projectKey ??
    sections.find((section) => section.threads.length > 0)?.project.projectKey ??
    input.projects[0]?.projectKey ??
    null;

  return {
    selectedProjectKey,
    sections: sections.filter((section) => section.project.projectKey === selectedProjectKey),
    countsByProjectKey,
  };
}

export function sessionGridLastActivityAt(thread: EnvironmentThreadShell): string {
  const candidates = [
    thread.latestUserMessageAt,
    thread.latestTurn?.completedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.requestedAt,
    thread.updatedAt,
    thread.createdAt,
  ];
  return (
    candidates
      .filter((candidate): candidate is string => candidate != null)
      .toSorted((left, right) => parseTimestampMs(right) - parseTimestampMs(left))[0] ??
    thread.createdAt
  );
}
