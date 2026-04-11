import type { EnvironmentId, ProjectId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import {
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  type ThreadStatusLatestTurnSnapshot,
  type ThreadStatusSessionSnapshot,
} from "../Sidebar.logic";
import type { AppState, EnvironmentState } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import type { LogicalProjectKey } from "../../logicalProject";

export interface SidebarProjectOrderingThreadSnapshot {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: LogicalProjectKey;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestUserMessageAt: string | null;
}

const EMPTY_PROJECT_ORDERING_THREAD_SNAPSHOTS: SidebarProjectOrderingThreadSnapshot[] = [];
const EMPTY_PROJECT_THREAD_KEYS: string[] = [];
const EMPTY_PROJECT_THREAD_STATUS_INPUTS: ProjectThreadStatusInput[] = [];
const EMPTY_SORTED_THREAD_KEYS_BY_LOGICAL_PROJECT = new Map<LogicalProjectKey, readonly string[]>();
const EMPTY_SORTED_PROJECT_KEYS: LogicalProjectKey[] = [];

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ProjectThreadStatusInput {
  threadKey: string;
  hasActionableProposedPlan: boolean;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  interactionMode: SidebarThreadSummary["interactionMode"];
  latestTurn: ThreadStatusLatestTurnSnapshot | null;
  session: ThreadStatusSessionSnapshot | null;
}

export interface SidebarThreadRowSnapshot {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  branch: string | null;
  worktreePath: string | null;
}

export interface SidebarThreadMetaSnapshot {
  activityTimestamp: string;
  isRunning: boolean;
}

interface ProjectThreadRenderEntry {
  threadKey: string;
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: LogicalProjectKey;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestUserMessageAt: string | null;
}

export interface SidebarProjectRenderStateSnapshot {
  hasOverflowingThreads: boolean;
  hiddenThreadKeys: readonly string[];
  renderedThreadKeys: readonly string[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
}

const EMPTY_PROJECT_RENDER_STATE: SidebarProjectRenderStateSnapshot = {
  hasOverflowingThreads: false,
  hiddenThreadKeys: EMPTY_PROJECT_THREAD_KEYS,
  renderedThreadKeys: EMPTY_PROJECT_THREAD_KEYS,
  showEmptyThreadState: false,
  shouldShowThreadPanel: false,
};

function resolveLogicalProjectKey(
  summary: SidebarThreadSummary,
  physicalToLogicalKey?: ReadonlyMap<string, LogicalProjectKey>,
): LogicalProjectKey {
  const physicalProjectKey = scopedProjectKey(
    scopeProjectRef(summary.environmentId, summary.projectId),
  );
  return physicalToLogicalKey?.get(physicalProjectKey) ?? physicalProjectKey;
}

function buildProjectThreadRenderEntry(
  summary: SidebarThreadSummary,
  physicalToLogicalKey?: ReadonlyMap<string, LogicalProjectKey>,
): ProjectThreadRenderEntry {
  return {
    threadKey: scopedThreadKey(scopeThreadRef(summary.environmentId, summary.id)),
    id: summary.id,
    environmentId: summary.environmentId,
    projectId: resolveLogicalProjectKey(summary, physicalToLogicalKey),
    createdAt: summary.createdAt,
    archivedAt: summary.archivedAt,
    updatedAt: summary.updatedAt,
    latestUserMessageAt: summary.latestUserMessageAt,
  };
}

function buildProjectThreadStatusInput(summary: SidebarThreadSummary): ProjectThreadStatusInput {
  return {
    threadKey: scopedThreadKey(scopeThreadRef(summary.environmentId, summary.id)),
    hasActionableProposedPlan: summary.hasActionableProposedPlan,
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
    interactionMode: summary.interactionMode,
    latestTurn: summary.latestTurn
      ? {
          turnId: summary.latestTurn.turnId,
          startedAt: summary.latestTurn.startedAt,
          completedAt: summary.latestTurn.completedAt,
        }
      : null,
    session: summary.session
      ? {
          orchestrationStatus: summary.session.orchestrationStatus,
          activeTurnId: summary.session.activeTurnId,
          status: summary.session.status,
        }
      : null,
  };
}

function forEachProjectThreadSummary(
  state: AppState,
  memberProjectRefs: readonly ScopedProjectRef[],
  visit: (summary: SidebarThreadSummary) => void,
): void {
  if (memberProjectRefs.length === 0) {
    return;
  }

  for (const ref of memberProjectRefs) {
    const environmentState = state.environmentStateById[ref.environmentId];
    if (!environmentState) {
      continue;
    }
    const threadIds = environmentState.threadIdsByProjectId[ref.projectId] ?? [];
    for (const threadId of threadIds) {
      const summary = environmentState.sidebarThreadSummaryById[threadId];
      if (!summary) {
        continue;
      }
      visit(summary);
    }
  }
}

function collectProjectThreadEntries(
  state: AppState,
  memberProjectRefs: readonly ScopedProjectRef[],
  physicalToLogicalKey?: ReadonlyMap<string, LogicalProjectKey>,
): ProjectThreadRenderEntry[] {
  const entries: ProjectThreadRenderEntry[] = [];
  forEachProjectThreadSummary(state, memberProjectRefs, (summary) => {
    entries.push(buildProjectThreadRenderEntry(summary, physicalToLogicalKey));
  });
  return entries;
}

function collectProjectThreadStatusInputs(
  state: AppState,
  memberProjectRefs: readonly ScopedProjectRef[],
): ProjectThreadStatusInput[] {
  const inputs: ProjectThreadStatusInput[] = [];
  forEachProjectThreadSummary(state, memberProjectRefs, (summary) => {
    inputs.push(buildProjectThreadStatusInput(summary));
  });
  return inputs;
}

function projectThreadStatusInputsEqual(
  left: ProjectThreadStatusInput | undefined,
  right: ProjectThreadStatusInput | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.threadKey === right.threadKey &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.interactionMode === right.interactionMode &&
    left.latestTurn?.turnId === right.latestTurn?.turnId &&
    left.latestTurn?.startedAt === right.latestTurn?.startedAt &&
    left.latestTurn?.completedAt === right.latestTurn?.completedAt &&
    left.session?.orchestrationStatus === right.session?.orchestrationStatus &&
    left.session?.activeTurnId === right.session?.activeTurnId &&
    left.session?.status === right.session?.status
  );
}

function includeUpdatedSortFields(
  sortOrder: SidebarProjectSortOrder | SidebarThreadSortOrder,
): boolean {
  return sortOrder === "updated_at";
}

export function createSidebarProjectOrderingThreadSnapshotsSelector(input: {
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
  sortOrder: SidebarProjectSortOrder;
}): (state: AppState) => readonly SidebarProjectOrderingThreadSnapshot[] {
  let previousResult:
    | readonly SidebarProjectOrderingThreadSnapshot[]
    | SidebarProjectOrderingThreadSnapshot[] = EMPTY_PROJECT_ORDERING_THREAD_SNAPSHOTS;
  let previousEntries = new Map<string, SidebarProjectOrderingThreadSnapshot>();

  return (state) => {
    if (input.sortOrder === "manual") {
      previousEntries = new Map<string, SidebarProjectOrderingThreadSnapshot>();
      previousResult = EMPTY_PROJECT_ORDERING_THREAD_SNAPSHOTS;
      return previousResult;
    }

    const watchUpdatedFields = includeUpdatedSortFields(input.sortOrder);
    const nextEntries = new Map<string, SidebarProjectOrderingThreadSnapshot>();
    const nextResult: SidebarProjectOrderingThreadSnapshot[] = [];
    let changed = false;

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[EnvironmentId, EnvironmentState]>) {
      for (const threadId of environmentState.threadIds) {
        const summary = environmentState.sidebarThreadSummaryById[threadId];
        if (!summary || summary.environmentId !== environmentId || summary.archivedAt !== null) {
          continue;
        }

        const logicalProjectKey = resolveLogicalProjectKey(summary, input.physicalToLogicalKey);
        const entryKey = `${environmentId}:${threadId}`;
        const previousEntry = previousEntries.get(entryKey);
        if (
          previousEntry &&
          previousEntry.id === summary.id &&
          previousEntry.environmentId === summary.environmentId &&
          previousEntry.projectId === logicalProjectKey &&
          previousEntry.createdAt === summary.createdAt &&
          previousEntry.archivedAt === summary.archivedAt &&
          (!watchUpdatedFields ||
            (previousEntry.updatedAt === summary.updatedAt &&
              previousEntry.latestUserMessageAt === summary.latestUserMessageAt))
        ) {
          nextEntries.set(entryKey, previousEntry);
          nextResult.push(previousEntry);
          if (previousResult[nextResult.length - 1] !== previousEntry) {
            changed = true;
          }
          continue;
        }

        const snapshot: SidebarProjectOrderingThreadSnapshot = {
          id: summary.id,
          environmentId: summary.environmentId,
          projectId: logicalProjectKey,
          createdAt: summary.createdAt,
          archivedAt: summary.archivedAt,
          updatedAt: summary.updatedAt,
          latestUserMessageAt: summary.latestUserMessageAt,
        };
        nextEntries.set(entryKey, snapshot);
        nextResult.push(snapshot);
        changed = true;
      }
    }

    if (previousResult.length !== nextResult.length) {
      changed = true;
    }

    if (!changed) {
      previousEntries = nextEntries;
      return previousResult;
    }

    previousEntries = nextEntries;
    previousResult = nextResult.length === 0 ? EMPTY_PROJECT_ORDERING_THREAD_SNAPSHOTS : nextResult;
    return previousResult;
  };
}

export function createSidebarSortedProjectKeysSelector(input: {
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
  projects: ReadonlyArray<{
    projectKey: LogicalProjectKey;
    name: string;
    createdAt?: string | undefined;
    updatedAt?: string | undefined;
  }>;
  sortOrder: SidebarProjectSortOrder;
}): (state: AppState) => readonly LogicalProjectKey[] {
  let previousResult: readonly LogicalProjectKey[] = EMPTY_SORTED_PROJECT_KEYS;
  const orderingThreadSelector = createSidebarProjectOrderingThreadSnapshotsSelector({
    physicalToLogicalKey: input.physicalToLogicalKey,
    sortOrder: input.sortOrder,
  });

  return (state) => {
    const manualProjectKeys = input.projects.map((project) => project.projectKey);
    if (input.sortOrder === "manual") {
      if (stringArraysEqual(previousResult, manualProjectKeys)) {
        return previousResult;
      }
      previousResult =
        manualProjectKeys.length === 0 ? EMPTY_SORTED_PROJECT_KEYS : manualProjectKeys;
      return previousResult;
    }

    const sortableProjects = input.projects.map((project) => ({
      id: project.projectKey,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }));
    const sortedProjectKeys = sortProjectsForSidebar(
      sortableProjects,
      orderingThreadSelector(state),
      input.sortOrder,
    ).map((project) => project.id);

    if (stringArraysEqual(previousResult, sortedProjectKeys)) {
      return previousResult;
    }

    previousResult = sortedProjectKeys.length === 0 ? EMPTY_SORTED_PROJECT_KEYS : sortedProjectKeys;
    return previousResult;
  };
}

export function createSidebarSortedThreadKeysByLogicalProjectSelector(input: {
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>;
  threadSortOrder: SidebarThreadSortOrder;
}): (state: AppState) => ReadonlyMap<LogicalProjectKey, readonly string[]> {
  let previousResult = EMPTY_SORTED_THREAD_KEYS_BY_LOGICAL_PROJECT;

  return (state) => {
    const groupedEntries = new Map<LogicalProjectKey, ProjectThreadRenderEntry[]>();
    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[EnvironmentId, EnvironmentState]>) {
      for (const threadId of environmentState.threadIds) {
        const summary = environmentState.sidebarThreadSummaryById[threadId];
        if (!summary || summary.environmentId !== environmentId || summary.archivedAt !== null) {
          continue;
        }

        const logicalProjectKey = resolveLogicalProjectKey(summary, input.physicalToLogicalKey);
        const projectEntries = groupedEntries.get(logicalProjectKey);
        const entry = buildProjectThreadRenderEntry(summary, input.physicalToLogicalKey);
        if (projectEntries) {
          projectEntries.push(entry);
        } else {
          groupedEntries.set(logicalProjectKey, [entry]);
        }
      }
    }

    const nextResult = new Map<LogicalProjectKey, readonly string[]>();
    let changed = previousResult.size !== groupedEntries.size;

    for (const [projectKey, entries] of groupedEntries) {
      const nextThreadKeys = sortThreadsForSidebar(entries, input.threadSortOrder).map(
        (thread) => thread.threadKey,
      );
      const previousThreadKeys = previousResult.get(projectKey);
      if (previousThreadKeys && stringArraysEqual(previousThreadKeys, nextThreadKeys)) {
        nextResult.set(projectKey, previousThreadKeys);
        continue;
      }

      nextResult.set(
        projectKey,
        nextThreadKeys.length === 0 ? EMPTY_PROJECT_THREAD_KEYS : nextThreadKeys,
      );
      changed = true;
    }

    if (!changed) {
      return previousResult;
    }

    previousResult =
      nextResult.size === 0 ? EMPTY_SORTED_THREAD_KEYS_BY_LOGICAL_PROJECT : nextResult;
    return previousResult;
  };
}

export function createSidebarThreadRowSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => SidebarThreadRowSnapshot | undefined {
  let previousResult: SidebarThreadRowSnapshot | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }

    const summary =
      state.environmentStateById[ref.environmentId]?.sidebarThreadSummaryById[ref.threadId];
    if (!summary) {
      return undefined;
    }

    const nextResult: SidebarThreadRowSnapshot = {
      id: summary.id,
      environmentId: summary.environmentId,
      projectId: summary.projectId,
      title: summary.title,
      branch: summary.branch,
      worktreePath: summary.worktreePath ?? null,
    };

    if (
      previousResult &&
      previousResult.id === nextResult.id &&
      previousResult.environmentId === nextResult.environmentId &&
      previousResult.projectId === nextResult.projectId &&
      previousResult.title === nextResult.title &&
      previousResult.branch === nextResult.branch &&
      previousResult.worktreePath === nextResult.worktreePath
    ) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarThreadStatusInputSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ProjectThreadStatusInput | undefined {
  let previousResult: ProjectThreadStatusInput | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }

    const summary =
      state.environmentStateById[ref.environmentId]?.sidebarThreadSummaryById[ref.threadId];
    if (!summary) {
      return undefined;
    }

    const nextResult = buildProjectThreadStatusInput(summary);

    if (projectThreadStatusInputsEqual(previousResult, nextResult)) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarThreadMetaSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => SidebarThreadMetaSnapshot | undefined {
  let previousResult: SidebarThreadMetaSnapshot | undefined;

  return (state) => {
    if (!ref) {
      return undefined;
    }

    const summary =
      state.environmentStateById[ref.environmentId]?.sidebarThreadSummaryById[ref.threadId];
    if (!summary) {
      return undefined;
    }

    const nextResult: SidebarThreadMetaSnapshot = {
      activityTimestamp: summary.updatedAt ?? summary.createdAt,
      isRunning: summary.session?.status === "running" && summary.session.activeTurnId != null,
    };

    if (
      previousResult &&
      previousResult.activityTimestamp === nextResult.activityTimestamp &&
      previousResult.isRunning === nextResult.isRunning
    ) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarActiveRouteProjectKeySelectorByRef(
  ref: ScopedThreadRef | null | undefined,
  physicalToLogicalKey: ReadonlyMap<string, LogicalProjectKey>,
): (state: AppState) => LogicalProjectKey | null {
  let previousResult: LogicalProjectKey | null = null;

  return (state) => {
    if (!ref) {
      previousResult = null;
      return null;
    }

    const summary =
      state.environmentStateById[ref.environmentId]?.sidebarThreadSummaryById[ref.threadId];
    if (!summary) {
      previousResult = null;
      return null;
    }

    const nextResult = resolveLogicalProjectKey(summary, physicalToLogicalKey);
    if (previousResult === nextResult) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarProjectRenderStateSelector(input: {
  activeRouteThreadKey: string | null;
  isThreadListExpanded: boolean;
  memberProjectRefs: readonly ScopedProjectRef[];
  physicalToLogicalKey?: ReadonlyMap<string, LogicalProjectKey>;
  projectExpanded: boolean;
  previewLimit: number;
  threadSortOrder: SidebarThreadSortOrder;
}): (state: AppState) => SidebarProjectRenderStateSnapshot {
  let previousResult = EMPTY_PROJECT_RENDER_STATE;

  return (state) => {
    const visibleProjectThreads = sortThreadsForSidebar(
      collectProjectThreadEntries(
        state,
        input.memberProjectRefs,
        input.physicalToLogicalKey,
      ).filter((thread) => thread.archivedAt === null),
      input.threadSortOrder,
    );
    const pinnedCollapsedThread =
      !input.projectExpanded && input.activeRouteThreadKey
        ? (visibleProjectThreads.find(
            (thread) => thread.threadKey === input.activeRouteThreadKey,
          ) ?? null)
        : null;
    const shouldShowThreadPanel = input.projectExpanded || pinnedCollapsedThread !== null;
    const hasOverflowingThreads = visibleProjectThreads.length > input.previewLimit;
    const previewThreads =
      input.isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, input.previewLimit);
    const renderedThreadKeys = pinnedCollapsedThread
      ? [pinnedCollapsedThread.threadKey]
      : previewThreads.map((thread) => thread.threadKey);
    const renderedThreadKeySet = new Set(renderedThreadKeys);
    const hiddenThreadKeys = visibleProjectThreads
      .filter((thread) => !renderedThreadKeySet.has(thread.threadKey))
      .map((thread) => thread.threadKey);
    const nextResult: SidebarProjectRenderStateSnapshot = {
      hasOverflowingThreads,
      hiddenThreadKeys:
        hiddenThreadKeys.length === 0 ? EMPTY_PROJECT_THREAD_KEYS : hiddenThreadKeys,
      renderedThreadKeys:
        renderedThreadKeys.length === 0 ? EMPTY_PROJECT_THREAD_KEYS : renderedThreadKeys,
      showEmptyThreadState: input.projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel,
    };

    if (
      previousResult.hasOverflowingThreads === nextResult.hasOverflowingThreads &&
      previousResult.showEmptyThreadState === nextResult.showEmptyThreadState &&
      previousResult.shouldShowThreadPanel === nextResult.shouldShowThreadPanel &&
      stringArraysEqual(previousResult.renderedThreadKeys, nextResult.renderedThreadKeys) &&
      stringArraysEqual(previousResult.hiddenThreadKeys, nextResult.hiddenThreadKeys)
    ) {
      return previousResult;
    }

    previousResult = nextResult;
    return nextResult;
  };
}

export function createSidebarProjectThreadStatusInputsSelector(
  memberProjectRefs: readonly ScopedProjectRef[],
): (state: AppState) => readonly ProjectThreadStatusInput[] {
  let previousResult: readonly ProjectThreadStatusInput[] = EMPTY_PROJECT_THREAD_STATUS_INPUTS;

  return (state) => {
    const nextInputs = collectProjectThreadStatusInputs(state, memberProjectRefs);
    if (
      previousResult.length === nextInputs.length &&
      previousResult.every((previousInput, index) => {
        const nextInput = nextInputs[index];
        return nextInput !== undefined && projectThreadStatusInputsEqual(previousInput, nextInput);
      })
    ) {
      return previousResult;
    }

    previousResult = nextInputs.length === 0 ? EMPTY_PROJECT_THREAD_STATUS_INPUTS : nextInputs;
    return previousResult;
  };
}
