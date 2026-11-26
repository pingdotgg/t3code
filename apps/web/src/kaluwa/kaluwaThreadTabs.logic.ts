// Fork: the tab model behind Kaluwa's titlebar tabs. Pure, so the store, the shortcuts and the
// tests share one set of rules. A tab is a thread ("thread:<env>:<id>") or a new-thread draft
// ("draft:<id>"). Pinned tabs come first; a group's tabs sit together; closed tabs are kept in
// batches so they can be reopened.
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

export type ThreadTabKey = string;

/** Group colours are palette swatches, so groups follow the Kaluwa look. */
export const THREAD_TAB_GROUP_COLORS = [
  "steel",
  "clay",
  "ochre",
  "sage",
  "plum",
  "rose",
  "lagoon",
  "dusk",
  "ash",
] as const;
export type ThreadTabGroupColor = (typeof THREAD_TAB_GROUP_COLORS)[number];

export interface ThreadTabGroup {
  readonly id: string;
  readonly name: string;
  readonly color: ThreadTabGroupColor;
  readonly collapsed: boolean;
}

interface ClosedThreadTab {
  readonly key: ThreadTabKey;
  readonly index: number;
  readonly pinned: boolean;
  readonly group: ThreadTabGroup | null;
}

export interface ThreadTabsState {
  readonly tabs: ReadonlyArray<ThreadTabKey>;
  readonly active: ThreadTabKey | null;
  readonly pinned: ReadonlyArray<ThreadTabKey>;
  readonly groupOf: Readonly<Record<ThreadTabKey, string>>;
  readonly groups: ReadonlyArray<ThreadTabGroup>;
  /** Batches of closed tabs, newest last; one close action is one batch. */
  readonly closed: ReadonlyArray<ReadonlyArray<ClosedThreadTab>>;
}

export type ThreadTabTarget =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "draft"; readonly draftId: string };

export const EMPTY_THREAD_TABS: ThreadTabsState = {
  tabs: [],
  active: null,
  pinned: [],
  groupOf: {},
  groups: [],
  closed: [],
};

const THREAD_PREFIX = "thread:";
const DRAFT_PREFIX = "draft:";
const MAX_STORED_TABS = 60;
const MAX_CLOSED_BATCHES = 10;
const MAX_GROUP_NAME = 40;

export function threadTabKeyForThread(ref: ScopedThreadRef): ThreadTabKey {
  return `${THREAD_PREFIX}${scopedThreadKey(ref)}`;
}

export function threadTabKeyForDraft(draftId: string): ThreadTabKey {
  return `${DRAFT_PREFIX}${draftId}`;
}

export function parseThreadTabKey(key: ThreadTabKey): ThreadTabTarget | null {
  if (key.startsWith(DRAFT_PREFIX)) {
    const draftId = key.slice(DRAFT_PREFIX.length);
    return draftId.length > 0 ? { kind: "draft", draftId } : null;
  }
  if (!key.startsWith(THREAD_PREFIX)) return null;
  const ref = parseScopedThreadKey(key.slice(THREAD_PREFIX.length));
  return ref === null ? null : { kind: "thread", ref };
}

function uniqueValidKeys(keys: ReadonlyArray<unknown>): ThreadTabKey[] {
  const seen = new Set<ThreadTabKey>();
  for (const key of keys) {
    if (typeof key !== "string" || seen.has(key) || parseThreadTabKey(key) === null) continue;
    seen.add(key);
  }
  return [...seen];
}

/**
 * Restores the invariants every change relies on: no repeats, pinned tabs first and never
 * grouped, each group's tabs together where its first tab is, no empty groups.
 */
function normalize(state: ThreadTabsState): ThreadTabsState {
  const tabs = uniqueValidKeys(state.tabs);
  const present = new Set(tabs);
  const pinnedSet = new Set(state.pinned.filter((key) => present.has(key)));
  const groupIds = new Set(state.groups.map((group) => group.id));
  const groupOf: Record<ThreadTabKey, string> = {};
  for (const key of tabs) {
    const groupId = state.groupOf[key];
    if (groupId !== undefined && groupIds.has(groupId) && !pinnedSet.has(key)) {
      groupOf[key] = groupId;
    }
  }
  const pinned = tabs.filter((key) => pinnedSet.has(key));
  const ordered: ThreadTabKey[] = [...pinned];
  const emittedGroups = new Set<string>();
  for (const key of tabs) {
    if (pinnedSet.has(key)) continue;
    const groupId = groupOf[key];
    if (groupId === undefined) {
      ordered.push(key);
      continue;
    }
    if (emittedGroups.has(groupId)) continue;
    emittedGroups.add(groupId);
    for (const member of tabs) if (groupOf[member] === groupId) ordered.push(member);
  }
  return {
    tabs: ordered,
    active: state.active !== null && present.has(state.active) ? state.active : null,
    pinned,
    groupOf,
    groups: state.groups.filter((group) => emittedGroups.has(group.id)),
    closed: state.closed.slice(-MAX_CLOSED_BATCHES),
  };
}

function decodeGroup(value: unknown): ThreadTabGroup | null {
  if (typeof value !== "object" || value === null) return null;
  const group = value as Record<string, unknown>;
  const color = THREAD_TAB_GROUP_COLORS.find((candidate) => candidate === group.color);
  if (typeof group.id !== "string" || group.id.length === 0 || color === undefined) return null;
  return {
    id: group.id,
    name: typeof group.name === "string" ? group.name.slice(0, MAX_GROUP_NAME) : "",
    color,
    collapsed: group.collapsed === true,
  };
}

function decodeClosedBatch(value: unknown): ClosedThreadTab[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ClosedThreadTab[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const tab = entry as Record<string, unknown>;
    if (typeof tab.key !== "string" || parseThreadTabKey(tab.key) === null) return [];
    return [
      {
        key: tab.key,
        index: typeof tab.index === "number" && tab.index >= 0 ? Math.floor(tab.index) : 0,
        pinned: tab.pinned === true,
        group: decodeGroup(tab.group),
      },
    ];
  });
}

/** Reads stored tabs, dropping anything malformed or repeated. */
export function decodeThreadTabs(raw: string | null): ThreadTabsState {
  let parsed: unknown = null;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return EMPTY_THREAD_TABS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_THREAD_TABS;
  }
  const value = parsed as Record<string, unknown>;
  const tabs = uniqueValidKeys(Array.isArray(value.tabs) ? value.tabs : []).slice(
    0,
    MAX_STORED_TABS,
  );
  const groupOf: Record<string, string> = {};
  if (typeof value.groupOf === "object" && value.groupOf !== null) {
    for (const [key, groupId] of Object.entries(value.groupOf)) {
      if (typeof groupId === "string") groupOf[key] = groupId;
    }
  }
  const groups = (Array.isArray(value.groups) ? value.groups : []).flatMap((entry) => {
    const group = decodeGroup(entry);
    return group === null ? [] : [group];
  });
  return normalize({
    tabs,
    active: typeof value.active === "string" ? value.active : null,
    pinned: Array.isArray(value.pinned)
      ? value.pinned.filter((key): key is string => typeof key === "string")
      : [],
    groupOf,
    groups,
    closed: (Array.isArray(value.closed) ? value.closed : [])
      .map(decodeClosedBatch)
      .filter((batch) => batch.length > 0),
  });
}

export function encodeThreadTabs(state: ThreadTabsState): string {
  return JSON.stringify(state);
}

function withGroupExpanded(state: ThreadTabsState, key: ThreadTabKey): ThreadTabsState {
  const groupId = state.groupOf[key];
  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group?.collapsed) return state;
  return {
    ...state,
    groups: state.groups.map((candidate) =>
      candidate === group ? { ...candidate, collapsed: false } : candidate,
    ),
  };
}

/**
 * The route now shows `key`. An open tab for it becomes active. Otherwise it opens in a new tab
 * after the active one (joining the active tab's group, or after the pinned tabs), or it takes
 * the active tab's place when `replaceActive` (a sent draft becoming its thread) or when tabs
 * open in the current tab and the active one is not pinned.
 */
export function followThreadTabRoute(
  state: ThreadTabsState,
  key: ThreadTabKey,
  options: { readonly newTab: boolean; readonly replaceActive?: boolean },
): ThreadTabsState {
  if (state.tabs.includes(key)) {
    const expanded = withGroupExpanded(state, key);
    return expanded.active === key ? expanded : { ...expanded, active: key };
  }
  const active = state.active;
  const activeIndex = active === null ? -1 : state.tabs.indexOf(active);
  if (activeIndex === -1 || active === null) {
    return normalize({ ...state, tabs: [...state.tabs, key], active: key });
  }
  const activePinned = state.pinned.includes(active);
  if (options.replaceActive || (!options.newTab && !activePinned)) {
    const tabs = [...state.tabs];
    tabs[activeIndex] = key;
    const groupOf: Record<string, string> = { ...state.groupOf };
    const groupId = groupOf[active];
    delete groupOf[active];
    if (groupId !== undefined) groupOf[key] = groupId;
    const pinned = state.pinned.map((tab) => (tab === active ? key : tab));
    return normalize({ ...state, tabs, active: key, pinned, groupOf });
  }
  const tabs = [...state.tabs];
  const insertAt = activePinned ? state.pinned.length : activeIndex + 1;
  tabs.splice(insertAt, 0, key);
  const groupId = state.groupOf[active];
  const groupOf = groupId === undefined ? state.groupOf : { ...state.groupOf, [key]: groupId };
  return normalize({ ...state, tabs, active: key, groupOf });
}

function groupById(state: ThreadTabsState, groupId: string | undefined) {
  return groupId === undefined
    ? null
    : (state.groups.find((group) => group.id === groupId) ?? null);
}

/**
 * Closes `keys` as one batch for Reopen. Closing the active tab activates the nearest remaining
 * tab to its right, else to its left.
 */
export function closeThreadTabs(
  state: ThreadTabsState,
  keys: ReadonlyArray<ThreadTabKey>,
): { readonly state: ThreadTabsState; readonly activate: ThreadTabKey | null } {
  const closing = new Set(keys.filter((key) => state.tabs.includes(key)));
  if (closing.size === 0) return { state, activate: null };
  const batch: ClosedThreadTab[] = state.tabs.flatMap((key, index) =>
    closing.has(key)
      ? [
          {
            key,
            index,
            pinned: state.pinned.includes(key),
            group: groupById(state, state.groupOf[key]),
          },
        ]
      : [],
  );
  let activate: ThreadTabKey | null = null;
  let active = state.active;
  if (active !== null && closing.has(active)) {
    const from = state.tabs.indexOf(active);
    activate =
      state.tabs.slice(from + 1).find((key) => !closing.has(key)) ??
      state.tabs
        .slice(0, from)
        .toReversed()
        .find((key) => !closing.has(key)) ??
      null;
    active = activate;
  }
  return {
    state: normalize({
      ...state,
      tabs: state.tabs.filter((key) => !closing.has(key)),
      active,
      closed: [...state.closed, batch],
    }),
    activate,
  };
}

export function closeThreadTab(state: ThreadTabsState, key: ThreadTabKey) {
  return closeThreadTabs(state, [key]);
}

/** Tabs "Close other tabs" closes: every unpinned tab but `key`. */
export function otherThreadTabs(state: ThreadTabsState, key: ThreadTabKey): ThreadTabKey[] {
  return state.tabs.filter((tab) => tab !== key && !state.pinned.includes(tab));
}

/** Tabs "Close tabs to the right" closes: unpinned tabs after `key`. */
export function threadTabsToTheRight(state: ThreadTabsState, key: ThreadTabKey): ThreadTabKey[] {
  const index = state.tabs.indexOf(key);
  if (index === -1) return [];
  return state.tabs.slice(index + 1).filter((tab) => !state.pinned.includes(tab));
}

/** Tabs "Close all tabs" closes: every unpinned tab. */
export function unpinnedThreadTabs(state: ThreadTabsState): ThreadTabKey[] {
  return state.tabs.filter((tab) => !state.pinned.includes(tab));
}

/** Reopens the last closed batch where it was, with its pins and groups. */
export function reopenClosedThreadTabs(state: ThreadTabsState): {
  readonly state: ThreadTabsState;
  readonly activate: ThreadTabKey | null;
} {
  const batch = state.closed.at(-1);
  if (batch === undefined) return { state, activate: null };
  const tabs = [...state.tabs];
  const pinned = [...state.pinned];
  const groupOf: Record<string, string> = { ...state.groupOf };
  const groups = [...state.groups];
  let activate: ThreadTabKey | null = null;
  for (const entry of batch.toSorted((left, right) => left.index - right.index)) {
    activate ??= entry.key;
    if (tabs.includes(entry.key)) continue;
    tabs.splice(Math.min(entry.index, tabs.length), 0, entry.key);
    if (entry.pinned) pinned.push(entry.key);
    if (entry.group !== null) {
      if (!groups.some((group) => group.id === entry.group?.id)) groups.push(entry.group);
      groupOf[entry.key] = entry.group.id;
    }
  }
  return {
    state: normalize({
      tabs,
      active: activate ?? state.active,
      pinned,
      groupOf,
      groups,
      closed: state.closed.slice(0, -1),
    }),
    activate,
  };
}

/** Tabs in strip order without those hidden in collapsed groups, except the active one. */
function visibleThreadTabs(state: ThreadTabsState): ThreadTabKey[] {
  const collapsed = new Set(state.groups.filter((group) => group.collapsed).map((g) => g.id));
  return state.tabs.filter((key) => {
    const groupId = state.groupOf[key];
    return key === state.active || groupId === undefined || !collapsed.has(groupId);
  });
}

/** The visible tab `delta` places from the active one, wrapping around. */
export function relativeThreadTab(state: ThreadTabsState, delta: number): ThreadTabKey | null {
  const tabs = visibleThreadTabs(state);
  const count = tabs.length;
  if (count === 0) return null;
  const index = state.active === null ? -1 : tabs.indexOf(state.active);
  if (index === -1) return tabs[delta >= 0 ? 0 : count - 1] ?? null;
  return tabs[(((index + delta) % count) + count) % count] ?? null;
}

/** Visible tab N (0-based); like a browser, the ninth always means the last tab. */
export function threadTabAt(state: ThreadTabsState, index: number): ThreadTabKey | null {
  const tabs = visibleThreadTabs(state);
  if (index >= 8) return tabs.at(-1) ?? null;
  return tabs[index] ?? null;
}

export function pinThreadTab(state: ThreadTabsState, key: ThreadTabKey): ThreadTabsState {
  if (!state.tabs.includes(key) || state.pinned.includes(key)) return state;
  const tabs = state.tabs.filter((tab) => tab !== key);
  tabs.splice(state.pinned.length, 0, key);
  const groupOf = { ...state.groupOf };
  delete groupOf[key];
  return normalize({ ...state, tabs, pinned: [...state.pinned, key], groupOf });
}

export function unpinThreadTab(state: ThreadTabsState, key: ThreadTabKey): ThreadTabsState {
  if (!state.pinned.includes(key)) return state;
  const pinned = state.pinned.filter((tab) => tab !== key);
  const tabs = state.tabs.filter((tab) => tab !== key);
  tabs.splice(pinned.length, 0, key);
  return normalize({ ...state, tabs, pinned });
}

/** The first palette colour no group uses yet. */
export function nextThreadTabGroupColor(state: ThreadTabsState): ThreadTabGroupColor {
  const used = new Set(state.groups.map((group) => group.color));
  return (
    THREAD_TAB_GROUP_COLORS.find((color) => !used.has(color)) ??
    THREAD_TAB_GROUP_COLORS[state.groups.length % THREAD_TAB_GROUP_COLORS.length]!
  );
}

/** Puts `keys` in a new group where the first of them is; pinned tabs are unpinned. */
export function createThreadTabGroup(
  state: ThreadTabsState,
  keys: ReadonlyArray<ThreadTabKey>,
  group: { readonly id: string; readonly color: ThreadTabGroupColor; readonly name?: string },
): ThreadTabsState {
  const members = keys.filter((key) => state.tabs.includes(key));
  if (members.length === 0) return state;
  let next = state;
  for (const key of members) next = unpinThreadTab(next, key);
  const groupOf = { ...next.groupOf };
  for (const key of members) groupOf[key] = group.id;
  return normalize({
    ...next,
    groupOf,
    groups: [
      ...next.groups,
      { id: group.id, name: group.name ?? "", color: group.color, collapsed: false },
    ],
  });
}

export function threadTabGroupMembers(state: ThreadTabsState, groupId: string): ThreadTabKey[] {
  return state.tabs.filter((key) => state.groupOf[key] === groupId);
}

/** Moves `key` to the end of a group and into it. */
export function addThreadTabToGroup(
  state: ThreadTabsState,
  key: ThreadTabKey,
  groupId: string,
): ThreadTabsState {
  if (!state.groups.some((group) => group.id === groupId)) return state;
  const unpinned = unpinThreadTab(state, key);
  const members = threadTabGroupMembers(unpinned, groupId).filter((tab) => tab !== key);
  const tabs = unpinned.tabs.filter((tab) => tab !== key);
  const last = members.at(-1);
  tabs.splice(last === undefined ? tabs.length : tabs.indexOf(last) + 1, 0, key);
  return normalize({ ...unpinned, tabs, groupOf: { ...unpinned.groupOf, [key]: groupId } });
}

/** Takes `key` out of its group, placing it right after the group. */
export function removeThreadTabFromGroup(
  state: ThreadTabsState,
  key: ThreadTabKey,
): ThreadTabsState {
  const groupId = state.groupOf[key];
  if (groupId === undefined) return state;
  const members = threadTabGroupMembers(state, groupId);
  const tabs = state.tabs.filter((tab) => tab !== key);
  const last = members.filter((tab) => tab !== key).at(-1);
  if (last !== undefined) tabs.splice(tabs.indexOf(last) + 1, 0, key);
  else tabs.splice(state.tabs.indexOf(key), 0, key);
  const groupOf = { ...state.groupOf };
  delete groupOf[key];
  return normalize({ ...state, tabs, groupOf });
}

export function updateThreadTabGroup(
  state: ThreadTabsState,
  groupId: string,
  patch: Partial<Pick<ThreadTabGroup, "name" | "color" | "collapsed">>,
): ThreadTabsState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            ...patch,
            name: (patch.name ?? group.name).slice(0, MAX_GROUP_NAME),
          }
        : group,
    ),
  };
}

/** Dissolves a group; its tabs stay where they are. */
export function ungroupThreadTabs(state: ThreadTabsState, groupId: string): ThreadTabsState {
  return normalize({ ...state, groups: state.groups.filter((group) => group.id !== groupId) });
}

/**
 * Drops `key` next to `target`. A tab dropped between two tabs of one group joins it; one that
 * stays beside its own group keeps it; anywhere else it leaves its group. Pinned and unpinned
 * tabs stay in their own sections.
 */
export function dropThreadTab(
  state: ThreadTabsState,
  key: ThreadTabKey,
  target: ThreadTabKey,
  side: "before" | "after",
): ThreadTabsState {
  if (key === target || !state.tabs.includes(key) || !state.tabs.includes(target)) return state;
  const isPinned = state.pinned.includes(key);
  const tabs = state.tabs.filter((tab) => tab !== key);
  const pinnedCount = state.pinned.length - (isPinned ? 1 : 0);
  let index = tabs.indexOf(target) + (side === "after" ? 1 : 0);
  index = isPinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
  tabs.splice(index, 0, key);
  const groupOf = { ...state.groupOf };
  const own = groupOf[key];
  delete groupOf[key];
  if (!isPinned) {
    const left = tabs[index - 1];
    const right = tabs[index + 1];
    const leftGroup = left === undefined ? undefined : groupOf[left];
    const rightGroup = right === undefined ? undefined : groupOf[right];
    if (leftGroup !== undefined && leftGroup === rightGroup) groupOf[key] = leftGroup;
    else if (own !== undefined && (leftGroup === own || rightGroup === own)) groupOf[key] = own;
  }
  return normalize({ ...state, tabs, groupOf });
}

/** Moves a tab to the start or end of its section, out of any group. */
export function moveThreadTabToEdge(
  state: ThreadTabsState,
  key: ThreadTabKey,
  edge: "start" | "end",
): ThreadTabsState {
  if (!state.tabs.includes(key)) return state;
  const isPinned = state.pinned.includes(key);
  const tabs = state.tabs.filter((tab) => tab !== key);
  const pinnedCount = state.pinned.length - (isPinned ? 1 : 0);
  const index =
    edge === "start" ? (isPinned ? 0 : pinnedCount) : isPinned ? pinnedCount : tabs.length;
  tabs.splice(index, 0, key);
  const groupOf = { ...state.groupOf };
  delete groupOf[key];
  return normalize({ ...state, tabs, groupOf });
}

/**
 * Moves a whole group next to `target` (a tab, or null for the end). A target inside another
 * group moves it past that group instead of splitting it.
 */
export function moveThreadTabGroup(
  state: ThreadTabsState,
  groupId: string,
  target: ThreadTabKey | null,
  side: "before" | "after",
): ThreadTabsState {
  const members = threadTabGroupMembers(state, groupId);
  if (members.length === 0 || (target !== null && members.includes(target))) return state;
  const rest = state.tabs.filter((tab) => state.groupOf[tab] !== groupId);
  let index = rest.length;
  if (target !== null && rest.includes(target)) {
    const targetGroup = state.groupOf[target];
    if (targetGroup === undefined) {
      index = rest.indexOf(target) + (side === "after" ? 1 : 0);
    } else {
      const span = rest.filter((tab) => state.groupOf[tab] === targetGroup);
      index = side === "after" ? rest.indexOf(span.at(-1)!) + 1 : rest.indexOf(span[0]!);
    }
  }
  index = Math.max(index, state.pinned.length);
  rest.splice(index, 0, ...members);
  return normalize({ ...state, tabs: rest });
}

export interface ThreadTabLivenessInput {
  /** Scoped keys (`env:thread`) of every thread the client knows. */
  readonly knownThreadKeys: ReadonlySet<string>;
  /** Environments whose thread list is authoritative right now. */
  readonly liveEnvironmentIds: ReadonlySet<string>;
  readonly draftExists: (draftId: string) => boolean;
  /** Where a sent draft went, if it was sent. */
  readonly promotedTo: (draftId: string) => ScopedThreadRef | null;
}

/**
 * What a stored tab is now: itself, the thread its draft became, or null when it is gone. A thread
 * is only known gone once its environment's list is live, so tabs survive a slow reconnect.
 */
function resolveThreadTab(key: ThreadTabKey, input: ThreadTabLivenessInput): ThreadTabKey | null {
  const target = parseThreadTabKey(key);
  if (target === null) return null;
  if (target.kind === "draft") {
    if (input.draftExists(target.draftId)) return key;
    const promoted = input.promotedTo(target.draftId);
    return promoted === null ? null : threadTabKeyForThread(promoted);
  }
  if (!input.liveEnvironmentIds.has(target.ref.environmentId)) return key;
  return input.knownThreadKeys.has(scopedThreadKey(target.ref)) ? key : null;
}

/**
 * Drops gone tabs and swaps sent drafts for their threads, keeping their pins and groups. The
 * active tab is the route's, so it stays.
 */
export function pruneThreadTabs(
  state: ThreadTabsState,
  input: ThreadTabLivenessInput,
): ThreadTabsState {
  let changed = false;
  const tabs: ThreadTabKey[] = [];
  const pinned: ThreadTabKey[] = [];
  const groupOf: Record<ThreadTabKey, string> = {};
  for (const tab of state.tabs) {
    const next = tab === state.active ? tab : resolveThreadTab(tab, input);
    if (next !== tab) changed = true;
    if (next === null || tabs.includes(next)) continue;
    tabs.push(next);
    if (state.pinned.includes(tab)) pinned.push(next);
    const groupId = state.groupOf[tab];
    if (groupId !== undefined) groupOf[next] = groupId;
  }
  if (!changed) return state;
  return normalize({ ...state, tabs, pinned, groupOf });
}
