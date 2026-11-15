/** A thread open as a tab, by its scoped thread key. Pinned tabs always lead. */
export interface WorkspaceTab {
  readonly key: string;
  readonly pinned: boolean;
}

export interface WorkspaceTabsState {
  readonly tabs: ReadonlyArray<WorkspaceTab>;
  /** Most recently closed first. */
  readonly closed: ReadonlyArray<string>;
  /** A second thread shown beside the active one. */
  readonly split: { readonly key: string; readonly ratio: number } | null;
}

export const EMPTY_WORKSPACE_TABS: WorkspaceTabsState = { tabs: [], closed: [], split: null };

const MAX_UNPINNED_TABS = 24;
const MAX_CLOSED_TABS = 20;
const MIN_SPLIT_RATIO = 0.25;
const MAX_SPLIT_RATIO = 0.75;

const ordered = (tabs: ReadonlyArray<WorkspaceTab>): ReadonlyArray<WorkspaceTab> => [
  ...tabs.filter((tab) => tab.pinned),
  ...tabs.filter((tab) => !tab.pinned),
];

const rememberClosed = (closed: ReadonlyArray<string>, keys: ReadonlyArray<string>) =>
  [...keys.toReversed(), ...closed.filter((key) => !keys.includes(key))].slice(0, MAX_CLOSED_TABS);

const withoutSplitOf = (
  split: WorkspaceTabsState["split"],
  removed: ReadonlyArray<string>,
): WorkspaceTabsState["split"] => (split && removed.includes(split.key) ? null : split);

/** Opens `key` as the last tab; the oldest unpinned tab makes room when there are too many. */
export function visitTab(state: WorkspaceTabsState, key: string): WorkspaceTabsState {
  if (state.tabs.some((tab) => tab.key === key)) return state;
  let tabs = [...state.tabs, { key, pinned: false }];
  const unpinned = tabs.filter((tab) => !tab.pinned);
  const evicted =
    unpinned.length > MAX_UNPINNED_TABS
      ? unpinned.slice(0, unpinned.length - MAX_UNPINNED_TABS)
      : [];
  const evictedKeys = evicted.map((tab) => tab.key);
  tabs = tabs.filter((tab) => !evictedKeys.includes(tab.key));
  return {
    tabs,
    closed: state.closed.filter((closedKey) => closedKey !== key),
    split: withoutSplitOf(state.split, evictedKeys),
  };
}

/**
 * The tab to show once `closing` (which includes the active `key`) is gone: the nearest remaining
 * tab to the right, else to the left, else none.
 */
export function neighborAfterClose(
  state: WorkspaceTabsState,
  key: string,
  closing: ReadonlyArray<string> = [key],
): string | null {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return null;
  const remains = (tab: WorkspaceTab) => !closing.includes(tab.key);
  return (
    state.tabs.slice(index + 1).find(remains)?.key ??
    state.tabs.slice(0, index).findLast(remains)?.key ??
    null
  );
}

export function closeTabs(
  state: WorkspaceTabsState,
  keys: ReadonlyArray<string>,
): WorkspaceTabsState {
  const removed = state.tabs.filter((tab) => keys.includes(tab.key)).map((tab) => tab.key);
  if (removed.length === 0) return state;
  return {
    tabs: state.tabs.filter((tab) => !removed.includes(tab.key)),
    closed: rememberClosed(state.closed, removed),
    split: withoutSplitOf(state.split, removed),
  };
}

/** Unpinned tabs other than `key`, the way browsers close "other tabs". */
export function otherTabKeys(state: WorkspaceTabsState, key: string): ReadonlyArray<string> {
  return state.tabs.filter((tab) => !tab.pinned && tab.key !== key).map((tab) => tab.key);
}

export function tabKeysToRight(state: WorkspaceTabsState, key: string): ReadonlyArray<string> {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  return index === -1
    ? []
    : state.tabs
        .slice(index + 1)
        .filter((tab) => !tab.pinned)
        .map((tab) => tab.key);
}

/** Reopens the most recently closed tab that is not already open. */
export function reopenClosedTab(state: WorkspaceTabsState): {
  readonly state: WorkspaceTabsState;
  readonly key: string | null;
} {
  const open = new Set(state.tabs.map((tab) => tab.key));
  const key = state.closed.find((closedKey) => !open.has(closedKey)) ?? null;
  if (key === null) return { state: { ...state, closed: [] }, key: null };
  return { state: visitTab(state, key), key };
}

export function togglePinnedTab(state: WorkspaceTabsState, key: string): WorkspaceTabsState {
  const tab = state.tabs.find((candidate) => candidate.key === key);
  if (!tab) return state;
  const rest = state.tabs.filter((candidate) => candidate.key !== key);
  const pinned = rest.filter((candidate) => candidate.pinned);
  const unpinned = rest.filter((candidate) => !candidate.pinned);
  // Pinning puts the tab last among pinned tabs; unpinning puts it first among the rest.
  return {
    ...state,
    tabs: tab.pinned
      ? [...pinned, { key, pinned: false }, ...unpinned]
      : [...pinned, { key, pinned: true }, ...unpinned],
  };
}

/** Moves `from` to the position of `to`. A tab stays within its pinned or unpinned group. */
export function moveTab(state: WorkspaceTabsState, from: string, to: string): WorkspaceTabsState {
  const fromIndex = state.tabs.findIndex((tab) => tab.key === from);
  const toIndex = state.tabs.findIndex((tab) => tab.key === to);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return state;
  const moving = state.tabs[fromIndex]!;
  if (moving.pinned !== state.tabs[toIndex]!.pinned) return state;
  const tabs = [...state.tabs];
  tabs.splice(fromIndex, 1);
  tabs.splice(toIndex, 0, moving);
  return { ...state, tabs: ordered(tabs) };
}

/** The tab `offset` places from `key`, wrapping around. */
export function cycleTab(
  state: WorkspaceTabsState,
  key: string | null,
  offset: 1 | -1,
): string | null {
  if (state.tabs.length === 0) return null;
  const index = key === null ? -1 : state.tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return (offset === 1 ? state.tabs[0] : state.tabs.at(-1))?.key ?? null;
  return state.tabs[(index + offset + state.tabs.length) % state.tabs.length]!.key;
}

export function openSplit(state: WorkspaceTabsState, key: string, activeKey: string | null) {
  if (key === activeKey) return state;
  return {
    ...visitTab(state, key),
    split: { key, ratio: state.split?.ratio ?? 0.5 },
  };
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/** Persisted state from an older or hand-edited store, reduced to what is valid. */
export function sanitizeWorkspaceTabs(value: unknown): WorkspaceTabsState {
  if (typeof value !== "object" || value === null) return EMPTY_WORKSPACE_TABS;
  const record = value as Record<string, unknown>;
  const seen = new Set<string>();
  const tabs = (Array.isArray(record.tabs) ? record.tabs : []).flatMap((entry): WorkspaceTab[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { key, pinned } = entry as Record<string, unknown>;
    if (typeof key !== "string" || key === "" || seen.has(key)) return [];
    seen.add(key);
    return [{ key, pinned: pinned === true }];
  });
  const closed = (Array.isArray(record.closed) ? record.closed : [])
    .filter((key): key is string => typeof key === "string" && key !== "")
    .slice(0, MAX_CLOSED_TABS);
  const split = record.split as Record<string, unknown> | null | undefined;
  return {
    tabs: ordered(tabs),
    closed,
    split:
      split && typeof split.key === "string" && seen.has(split.key)
        ? { key: split.key, ratio: clampSplitRatio(Number(split.ratio)) }
        : null,
  };
}
