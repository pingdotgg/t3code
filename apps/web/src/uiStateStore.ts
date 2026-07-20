import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import { randomUUID } from "./lib/utils";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface PersistedUiState {
  projectExpandedById?: Record<string, boolean>;
  projectOrder?: string[];
  threadLastVisitedAtById?: Record<string, string>;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  /**
   * Cosmetic display labels for worktrees, keyed by worktree PATH (not thread).
   * A worktree can be shared by multiple threads, so keying by path keeps the
   * label consistent across every thread pointing at the same worktree.
   */
  worktreeLabelByPath?: Record<string, string>;
  threadGroups?: Array<{ id: string; projectKey: string; name: string; threadKeys: string[] }>;
  threadGroupOrderByProjectKey?: Record<string, string[]>;
  collapsedThreadGroupIds?: string[];
  // Manual thread order, keyed by sidebar project (logical) key. Thread keys are
  // stable (env + threadId), so this persists directly without id→cwd remapping.
  threadOrderByProject?: Record<string, string[]>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
  /** Manual thread order per sidebar project (logical) key. */
  threadOrderByProject: Record<string, string[]>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiWorktreeState {
  /** worktree path -> custom display label. See PersistedUiState.worktreeLabelByPath. */
  worktreeLabelByPath: Record<string, string>;
}

/**
 * A user-defined, client-only folder that groups a single project's threads in
 * the sidebar. Membership and within-folder order are both represented by the
 * ordered `threadKeys` array (the single source of truth). Folders are scoped to
 * one logical project via `projectKey`.
 */
export interface ThreadGroup {
  /** Stable generated id (see newThreadGroupId); never derived from contents. */
  id: string;
  /** Logical project key the folder lives under (same space as projectExpandedById). */
  projectKey: string;
  name: string;
  /** Ordered membership; the array order is the within-folder display order. */
  threadKeys: string[];
}

export interface UiGroupState {
  threadGroupsById: Record<string, ThreadGroup>;
  /** Ordered folder ids per logical project key. */
  threadGroupOrderByProjectKey: Record<string, string[]>;
  /** Folder collapse state. Absent id defaults to expanded, like projectExpandedById. */
  threadGroupExpandedById: Record<string, boolean>;
  /** Derived reverse index (threadKey -> groupId). Rebuilt on mutation; not persisted. */
  groupIdByThreadKey: Record<string, string>;
}

export interface UiState
  extends UiProjectState, UiThreadState, UiEndpointState, UiWorktreeState, UiGroupState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  threadOrderByProject: {},
  defaultAdvertisedEndpointKey: null,
  worktreeLabelByPath: {},
  threadGroupsById: {},
  threadGroupOrderByProjectKey: {},
  threadGroupExpandedById: {},
  groupIdByThreadKey: {},
};

const LEGACY_PROJECT_CWD_PREFERENCE_PREFIX = "legacy-project-cwd:";
const LEGACY_PROJECT_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
let legacyKeysCleanedUp = false;

export function legacyProjectCwdPreferenceKey(cwd: string): string {
  return `${LEGACY_PROJECT_CWD_PREFERENCE_PREFIX}${normalizeProjectPathForComparison(cwd)}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === "boolean",
    ),
  );
}

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

function dedupePreserveOrder(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Recompute the derived threadKey -> groupId reverse index from scratch. */
function rebuildGroupIndex(groups: Record<string, ThreadGroup>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const group of Object.values(groups)) {
    for (const threadKey of group.threadKeys) {
      index[threadKey] = group.id;
    }
  }
  return index;
}

/** Drop the given threadKeys from every folder. Returns the same map if unchanged. */
function removeThreadKeysFromGroups(
  groups: Record<string, ThreadGroup>,
  threadKeys: ReadonlySet<string>,
): Record<string, ThreadGroup> {
  let changed = false;
  const next: Record<string, ThreadGroup> = {};
  for (const [id, group] of Object.entries(groups)) {
    const filtered = group.threadKeys.filter((key) => !threadKeys.has(key));
    if (filtered.length !== group.threadKeys.length) {
      changed = true;
      next[id] = { ...group, threadKeys: filtered };
    } else {
      next[id] = group;
    }
  }
  return changed ? next : groups;
}

function sanitizePersistedThreadOrderByProject(
  value: PersistedUiState["threadOrderByProject"],
): Record<string, string[]> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, string[]> = {};
  for (const [projectKey, threadKeys] of Object.entries(value)) {
    if (!projectKey || !Array.isArray(threadKeys)) {
      continue;
    }
    const filtered = dedupePreserveOrder(
      threadKeys.filter((key): key is string => typeof key === "string" && key.length > 0),
    );
    if (filtered.length > 0) {
      nextState[projectKey] = filtered;
    }
  }

  return nextState;
}

export function sanitizePersistedThreadGroups(
  parsed: PersistedUiState,
): Pick<
  UiState,
  | "threadGroupsById"
  | "threadGroupOrderByProjectKey"
  | "threadGroupExpandedById"
  | "groupIdByThreadKey"
> {
  const threadGroupsById: Record<string, ThreadGroup> = {};
  for (const raw of parsed.threadGroups ?? []) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.id !== "string" ||
      raw.id.length === 0 ||
      typeof raw.projectKey !== "string" ||
      raw.projectKey.length === 0 ||
      typeof raw.name !== "string"
    ) {
      continue;
    }
    const threadKeys = Array.isArray(raw.threadKeys)
      ? dedupePreserveOrder(
          raw.threadKeys.filter((key): key is string => typeof key === "string" && key.length > 0),
        )
      : [];
    threadGroupsById[raw.id] = {
      id: raw.id,
      projectKey: raw.projectKey,
      name: raw.name,
      threadKeys,
    };
  }

  const threadGroupOrderByProjectKey: Record<string, string[]> = {};
  for (const [projectKey, order] of Object.entries(parsed.threadGroupOrderByProjectKey ?? {})) {
    if (typeof projectKey !== "string" || !Array.isArray(order)) {
      continue;
    }
    const filtered = dedupePreserveOrder(
      order.filter((id): id is string => typeof id === "string" && id in threadGroupsById),
    );
    if (filtered.length > 0) {
      threadGroupOrderByProjectKey[projectKey] = filtered;
    }
  }
  // Defensively append any folder missing from its project's order list.
  for (const group of Object.values(threadGroupsById)) {
    const order = threadGroupOrderByProjectKey[group.projectKey] ?? [];
    if (!order.includes(group.id)) {
      threadGroupOrderByProjectKey[group.projectKey] = [...order, group.id];
    }
  }

  const collapsed = new Set(
    (parsed.collapsedThreadGroupIds ?? []).filter((id): id is string => typeof id === "string"),
  );
  const threadGroupExpandedById: Record<string, boolean> = {};
  for (const id of Object.keys(threadGroupsById)) {
    if (collapsed.has(id)) {
      threadGroupExpandedById[id] = false;
    }
  }

  return {
    threadGroupsById,
    threadGroupOrderByProjectKey,
    threadGroupExpandedById,
    groupIdByThreadKey: rebuildGroupIndex(threadGroupsById),
  };
}

export function parsePersistedState(parsed: PersistedUiState): UiState {
  const projectExpandedById =
    parsed.projectExpandedById === undefined
      ? (() => {
          const migrated: Record<string, boolean> = {};
          const collapsedProjectCwds = sanitizeStringArray(parsed.collapsedProjectCwds);
          const expandedProjectCwds = sanitizeStringArray(parsed.expandedProjectCwds);
          for (const cwd of collapsedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = false;
          }
          for (const cwd of expandedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = true;
          }
          if (!Array.isArray(parsed.collapsedProjectCwds) && expandedProjectCwds.length > 0) {
            migrated[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] = false;
          }
          return migrated;
        })()
      : sanitizeBooleanRecord(parsed.projectExpandedById);
  const projectOrder =
    parsed.projectOrder === undefined
      ? sanitizeStringArray(parsed.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
      : sanitizeStringArray(parsed.projectOrder);

  return {
    projectExpandedById,
    projectOrder,
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    threadChangedFilesExpandedById: sanitizePersistedThreadChangedFilesExpanded(
      parsed.threadChangedFilesExpandedById,
    ),
    threadOrderByProject: sanitizePersistedThreadOrderByProject(parsed.threadOrderByProject),
    defaultAdvertisedEndpointKey:
      typeof parsed.defaultAdvertisedEndpointKey === "string" &&
      parsed.defaultAdvertisedEndpointKey.length > 0
        ? parsed.defaultAdvertisedEndpointKey
        : null,
    worktreeLabelByPath: sanitizePersistedWorktreeLabels(parsed.worktreeLabelByPath),
    ...sanitizePersistedThreadGroups(parsed),
  };
}

function sanitizePersistedWorktreeLabels(
  value: PersistedUiState["worktreeLabelByPath"],
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const nextState: Record<string, string> = {};
  for (const [path, label] of Object.entries(value)) {
    if (!path || typeof label !== "string") {
      continue;
    }
    const trimmed = label.trim();
    if (trimmed.length > 0) {
      nextState[path] = trimmed;
    }
  }
  return nextState;
}

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        return parsePersistedState(JSON.parse(legacyRaw) as PersistedUiState);
      }
      return initialState;
    }
    return parsePersistedState(JSON.parse(raw) as PersistedUiState);
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean" && expanded === false) {
        nextTurns[turnId] = false;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const projectExpandedById = Object.fromEntries(
      Object.entries(state.projectExpandedById).filter(
        ([key]) => key !== LEGACY_PROJECT_EXPANSION_DEFAULT_KEY,
      ),
    );
    const threadChangedFilesExpandedById = Object.fromEntries(
      Object.entries(state.threadChangedFilesExpandedById).flatMap(([threadId, turns]) => {
        const nextTurns = Object.fromEntries(
          Object.entries(turns).filter(([, expanded]) => expanded === false),
        );
        return Object.keys(nextTurns).length > 0 ? [[threadId, nextTurns]] : [];
      }),
    );
    const threadGroups = Object.values(state.threadGroupsById).map((group) => ({
      id: group.id,
      projectKey: group.projectKey,
      name: group.name,
      threadKeys: group.threadKeys,
    }));
    const collapsedThreadGroupIds = Object.entries(state.threadGroupExpandedById)
      .filter(([, expanded]) => !expanded)
      .map(([id]) => id);
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById,
        projectOrder: state.projectOrder,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        threadChangedFilesExpandedById,
        worktreeLabelByPath: state.worktreeLabelByPath,
        threadGroups,
        threadGroupOrderByProjectKey: state.threadGroupOrderByProjectKey,
        collapsedThreadGroupIds,
        threadOrderByProject: state.threadOrderByProject,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function markThreadVisited(state: UiState, threadId: string, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return state;
  }
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: visitedAt,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[turnId] ?? true;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded) {
    if (!(turnId in currentThreadState)) {
      return state;
    }

    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[turnId];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadChangedFilesExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadChangedFilesExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadChangedFilesExpandedById: {
        ...state.threadChangedFilesExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: false,
      },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function setWorktreeLabel(state: UiState, worktreePath: string, label: string): UiState {
  // The worktree path is an exact identifier — key by it verbatim so writers
  // and readers (useWorktreeLabel, worktreeDisplayName) always agree. Reject a
  // blank path outright.
  if (!worktreePath.trim()) {
    return state;
  }
  const trimmedLabel = label.trim();
  const currentLabel = state.worktreeLabelByPath[worktreePath];

  // Empty label clears any existing custom name (falls back to the path-derived
  // display name).
  if (trimmedLabel.length === 0) {
    if (currentLabel === undefined) {
      return state;
    }
    const nextWorktreeLabelByPath = { ...state.worktreeLabelByPath };
    delete nextWorktreeLabelByPath[worktreePath];
    return {
      ...state,
      worktreeLabelByPath: nextWorktreeLabelByPath,
    };
  }

  if (currentLabel === trimmedLabel) {
    return state;
  }
  return {
    ...state,
    worktreeLabelByPath: {
      ...state.worktreeLabelByPath,
      [worktreePath]: trimmedLabel,
    },
  };
}

export function resolveProjectExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  preferenceKeys: readonly string[],
): boolean {
  for (const key of preferenceKeys) {
    const expanded = projectExpandedById[key];
    if (expanded !== undefined) {
      return expanded;
    }
  }
  return projectExpandedById[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] ?? true;
}

export function setProjectExpanded(
  state: UiState,
  projectIds: string | readonly string[],
  expanded: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const nextEntries = ids.filter((projectId) => state.projectExpandedById[projectId] !== expanded);
  if (nextEntries.length === 0) {
    return state;
  }
  const projectExpandedById = { ...state.projectExpandedById };
  for (const projectId of nextEntries) {
    projectExpandedById[projectId] = expanded;
  }
  return {
    ...state,
    projectExpandedById,
  };
}

export function reorderProjects(
  state: UiState,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = currentProjectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...currentProjectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

/** Generate a stable, unique thread-folder id. */
export function newThreadGroupId(): string {
  return `grp_${randomUUID()}`;
}

export function createThreadGroup(
  state: UiState,
  args: { projectKey: string; id: string; name: string; threadKeys?: readonly string[] },
): UiState {
  const { projectKey, id, name } = args;
  if (id in state.threadGroupsById) {
    return state;
  }
  const memberKeys = dedupePreserveOrder(args.threadKeys ?? []);
  const groupsWithoutMembers =
    memberKeys.length > 0
      ? removeThreadKeysFromGroups(state.threadGroupsById, new Set(memberKeys))
      : state.threadGroupsById;
  const nextGroups: Record<string, ThreadGroup> = {
    ...groupsWithoutMembers,
    [id]: { id, projectKey, name, threadKeys: memberKeys },
  };
  const order = state.threadGroupOrderByProjectKey[projectKey] ?? [];
  return {
    ...state,
    threadGroupsById: nextGroups,
    threadGroupOrderByProjectKey: {
      ...state.threadGroupOrderByProjectKey,
      [projectKey]: [...order, id],
    },
    groupIdByThreadKey: rebuildGroupIndex(nextGroups),
  };
}

export function renameThreadGroup(state: UiState, groupId: string, name: string): UiState {
  const group = state.threadGroupsById[groupId];
  const trimmed = name.trim();
  if (!group || trimmed.length === 0 || group.name === trimmed) {
    return state;
  }
  return {
    ...state,
    threadGroupsById: {
      ...state.threadGroupsById,
      [groupId]: { ...group, name: trimmed },
    },
  };
}

export function deleteThreadGroup(state: UiState, groupId: string): UiState {
  const group = state.threadGroupsById[groupId];
  if (!group) {
    return state;
  }
  const nextGroups = { ...state.threadGroupsById };
  delete nextGroups[groupId];

  const nextOrderByProject = { ...state.threadGroupOrderByProjectKey };
  const order = nextOrderByProject[group.projectKey];
  if (order) {
    const filtered = order.filter((id) => id !== groupId);
    if (filtered.length > 0) {
      nextOrderByProject[group.projectKey] = filtered;
    } else {
      delete nextOrderByProject[group.projectKey];
    }
  }

  const nextExpanded = { ...state.threadGroupExpandedById };
  delete nextExpanded[groupId];

  return {
    ...state,
    threadGroupsById: nextGroups,
    threadGroupOrderByProjectKey: nextOrderByProject,
    threadGroupExpandedById: nextExpanded,
    groupIdByThreadKey: rebuildGroupIndex(nextGroups),
  };
}

export function toggleThreadGroup(state: UiState, groupId: string): UiState {
  if (!(groupId in state.threadGroupsById)) {
    return state;
  }
  const expanded = state.threadGroupExpandedById[groupId] ?? true;
  return {
    ...state,
    threadGroupExpandedById: {
      ...state.threadGroupExpandedById,
      [groupId]: !expanded,
    },
  };
}

export function setThreadGroupExpanded(
  state: UiState,
  groupId: string,
  expanded: boolean,
): UiState {
  if (
    !(groupId in state.threadGroupsById) ||
    (state.threadGroupExpandedById[groupId] ?? true) === expanded
  ) {
    return state;
  }
  return {
    ...state,
    threadGroupExpandedById: {
      ...state.threadGroupExpandedById,
      [groupId]: expanded,
    },
  };
}

/**
 * Move one or more threads into a folder (or out to ungrouped when
 * targetGroupId is null). Also performs intra-folder reordering: each thread is
 * first removed from whatever folder holds it, then inserted into the target at
 * `beforeThreadKey` (or appended when null/absent). Mirrors reorderProjects in
 * taking an array so multi-select moves work in one call.
 */
export function moveThreadsToGroup(
  state: UiState,
  threadKeys: readonly string[],
  targetGroupId: string | null,
  beforeThreadKey?: string | null,
): UiState {
  if (threadKeys.length === 0) {
    return state;
  }
  if (targetGroupId !== null && !(targetGroupId in state.threadGroupsById)) {
    return state;
  }
  const movingKeys = dedupePreserveOrder(threadKeys);
  const movingSet = new Set(movingKeys);
  const groupsAfterRemoval = removeThreadKeysFromGroups(state.threadGroupsById, movingSet);

  let nextGroups = groupsAfterRemoval;
  if (targetGroupId !== null) {
    const target = groupsAfterRemoval[targetGroupId]!;
    const insertAt =
      beforeThreadKey != null
        ? (() => {
            const idx = target.threadKeys.indexOf(beforeThreadKey);
            return idx < 0 ? target.threadKeys.length : idx;
          })()
        : target.threadKeys.length;
    const nextThreadKeys = [
      ...target.threadKeys.slice(0, insertAt),
      ...movingKeys,
      ...target.threadKeys.slice(insertAt),
    ];
    nextGroups = {
      ...groupsAfterRemoval,
      [targetGroupId]: { ...target, threadKeys: nextThreadKeys },
    };
  }

  if (nextGroups === state.threadGroupsById) {
    return state;
  }
  return {
    ...state,
    threadGroupsById: nextGroups,
    groupIdByThreadKey: rebuildGroupIndex(nextGroups),
  };
}

/** Reorder a folder within its project's folder list, inserting before overGroupId. */
export function reorderThreadGroups(
  state: UiState,
  projectKey: string,
  draggedGroupId: string,
  overGroupId: string,
): UiState {
  if (draggedGroupId === overGroupId) {
    return state;
  }
  const order = state.threadGroupOrderByProjectKey[projectKey];
  if (!order) {
    return state;
  }
  const fromIndex = order.indexOf(draggedGroupId);
  const toIndex = order.indexOf(overGroupId);
  if (fromIndex < 0 || toIndex < 0) {
    return state;
  }
  const next = [...order];
  next.splice(fromIndex, 1);
  const insertAt = next.indexOf(overGroupId);
  next.splice(insertAt, 0, draggedGroupId);
  return {
    ...state,
    threadGroupOrderByProjectKey: {
      ...state.threadGroupOrderByProjectKey,
      [projectKey]: next,
    },
  };
}

/**
 * Reorder threads within a single sidebar project (or group). `orderedThreadKeys`
 * is the full, currently-displayed order — it seeds the persisted order even when
 * the user has never dragged this project before. Mirrors `reorderProjects`, but
 * operates on the live order rather than a pre-existing persisted array so it
 * works the first time a thread is dragged.
 */
export function reorderThreads(
  state: UiState,
  projectKey: string,
  orderedThreadKeys: readonly string[],
  draggedThreadKeys: readonly string[],
  targetThreadKey: string,
): UiState {
  if (draggedThreadKeys.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedThreadKeys);
  if (draggedSet.has(targetThreadKey)) {
    return state;
  }

  const nextOrder = [...orderedThreadKeys];
  const originalTargetIndex = nextOrder.indexOf(targetThreadKey);
  if (originalTargetIndex < 0) {
    return state;
  }

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = nextOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(nextOrder[i]!)) {
      removed.unshift(nextOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  nextOrder.splice(insertIndex, 0, ...removed);

  const previousOrder = state.threadOrderByProject[projectKey];
  if (previousOrder && stringListsEqual(previousOrder, nextOrder)) {
    return state;
  }

  return {
    ...state,
    threadOrderByProject: {
      ...state.threadOrderByProject,
      [projectKey]: nextOrder,
    },
  };
}

/**
 * Garbage-collect folder state against the live snapshot: drop memberships for
 * threads that no longer exist, and drop folders that have become empty AND
 * whose project is no longer rendered. Empty folders in a live project are kept
 * (a freshly-created folder must survive). Folders whose projectKey is stale but
 * still hold live members are left intact (their members fall back to ungrouped
 * until the project reappears).
 */
export function syncThreadGroups(
  state: UiState,
  args: { liveThreadKeys: ReadonlySet<string>; liveProjectKeys: ReadonlySet<string> },
): UiState {
  const { liveThreadKeys, liveProjectKeys } = args;
  let changed = false;
  const nextGroups: Record<string, ThreadGroup> = {};
  for (const [id, group] of Object.entries(state.threadGroupsById)) {
    const prunedKeys = group.threadKeys.filter((key) => liveThreadKeys.has(key));
    const projectLive = liveProjectKeys.has(group.projectKey);
    if (prunedKeys.length === 0 && !projectLive) {
      changed = true;
      continue;
    }
    if (prunedKeys.length !== group.threadKeys.length) {
      changed = true;
      nextGroups[id] = { ...group, threadKeys: prunedKeys };
    } else {
      nextGroups[id] = group;
    }
  }

  // Also prune manual ungrouped order entries for threads that no longer exist.
  const nextThreadOrderByProject: Record<string, string[]> = {};
  let orderChanged = false;
  for (const [projectKey, threadKeys] of Object.entries(state.threadOrderByProject)) {
    const retained = threadKeys.filter((key) => liveThreadKeys.has(key));
    if (retained.length !== threadKeys.length) {
      orderChanged = true;
    }
    if (retained.length > 0) {
      nextThreadOrderByProject[projectKey] = retained;
    } else if (threadKeys.length > 0) {
      orderChanged = true;
    }
  }

  if (!changed && !orderChanged) {
    return state;
  }

  const nextOrderByProject: Record<string, string[]> = {};
  for (const [projectKey, order] of Object.entries(state.threadGroupOrderByProjectKey)) {
    const filtered = order.filter((id) => id in nextGroups);
    if (filtered.length > 0) {
      nextOrderByProject[projectKey] = filtered;
    }
  }
  const nextExpanded: Record<string, boolean> = {};
  for (const [id, expanded] of Object.entries(state.threadGroupExpandedById)) {
    if (id in nextGroups) {
      nextExpanded[id] = expanded;
    }
  }
  return {
    ...state,
    threadGroupsById: changed ? nextGroups : state.threadGroupsById,
    threadGroupOrderByProjectKey: changed ? nextOrderByProject : state.threadGroupOrderByProjectKey,
    threadGroupExpandedById: changed ? nextExpanded : state.threadGroupExpandedById,
    groupIdByThreadKey: changed ? rebuildGroupIndex(nextGroups) : state.groupIdByThreadKey,
    threadOrderByProject: orderChanged ? nextThreadOrderByProject : state.threadOrderByProject,
  };
}

interface UiStateStore extends UiState {
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setWorktreeLabel: (worktreePath: string, label: string) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
  createThreadGroup: (args: {
    projectKey: string;
    id: string;
    name: string;
    threadKeys?: readonly string[];
  }) => void;
  renameThreadGroup: (groupId: string, name: string) => void;
  deleteThreadGroup: (groupId: string) => void;
  toggleThreadGroup: (groupId: string) => void;
  setThreadGroupExpanded: (groupId: string, expanded: boolean) => void;
  moveThreadsToGroup: (
    threadKeys: readonly string[],
    targetGroupId: string | null,
    beforeThreadKey?: string | null,
  ) => void;
  reorderThreadGroups: (projectKey: string, draggedGroupId: string, overGroupId: string) => void;
  reorderThreads: (
    projectKey: string,
    orderedThreadKeys: readonly string[],
    draggedThreadKeys: readonly string[],
    targetThreadKey: string,
  ) => void;
  syncThreadGroups: (args: {
    liveThreadKeys: ReadonlySet<string>;
    liveProjectKeys: ReadonlySet<string>;
  }) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setWorktreeLabel: (worktreePath, label) =>
    set((state) => setWorktreeLabel(state, worktreePath, label)),
  setProjectExpanded: (projectIds, expanded) =>
    set((state) => setProjectExpanded(state, projectIds, expanded)),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    set((state) =>
      reorderProjects(state, currentProjectOrder, draggedProjectIds, targetProjectIds),
    ),
  createThreadGroup: (args) => set((state) => createThreadGroup(state, args)),
  renameThreadGroup: (groupId, name) => set((state) => renameThreadGroup(state, groupId, name)),
  deleteThreadGroup: (groupId) => set((state) => deleteThreadGroup(state, groupId)),
  toggleThreadGroup: (groupId) => set((state) => toggleThreadGroup(state, groupId)),
  setThreadGroupExpanded: (groupId, expanded) =>
    set((state) => setThreadGroupExpanded(state, groupId, expanded)),
  moveThreadsToGroup: (threadKeys, targetGroupId, beforeThreadKey) =>
    set((state) => moveThreadsToGroup(state, threadKeys, targetGroupId, beforeThreadKey)),
  reorderThreadGroups: (projectKey, draggedGroupId, overGroupId) =>
    set((state) => reorderThreadGroups(state, projectKey, draggedGroupId, overGroupId)),
  reorderThreads: (projectKey, orderedThreadKeys, draggedThreadKeys, targetThreadKey) =>
    set((state) =>
      reorderThreads(state, projectKey, orderedThreadKeys, draggedThreadKeys, targetThreadKey),
    ),
  syncThreadGroups: (args) => set((state) => syncThreadGroups(state, args)),
}));

/**
 * Subscribe to the custom label for a single worktree path. Returns null when
 * no custom label is set (callers fall back to the path-derived name).
 */
export function useWorktreeLabel(worktreePath: string | null | undefined): string | null {
  return useUiStateStore((state) =>
    worktreePath ? (state.worktreeLabelByPath[worktreePath] ?? null) : null,
  );
}

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
