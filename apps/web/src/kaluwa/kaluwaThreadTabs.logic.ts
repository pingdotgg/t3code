// Fork: the tab model behind Kaluwa's titlebar tabs. Pure, so the store, the shortcuts and the
// tests share one set of rules. A tab is a thread ("thread:<env>:<id>") or a new-thread draft
// ("draft:<id>"); the active tab follows the route.
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

export type ThreadTabKey = string;

export interface ThreadTabsState {
  readonly tabs: ReadonlyArray<ThreadTabKey>;
  readonly active: ThreadTabKey | null;
}

export type ThreadTabTarget =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "draft"; readonly draftId: string };

export const EMPTY_THREAD_TABS: ThreadTabsState = { tabs: [], active: null };

const THREAD_PREFIX = "thread:";
const DRAFT_PREFIX = "draft:";
const MAX_STORED_TABS = 50;

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
  const value = parsed as { tabs?: unknown; active?: unknown };
  const tabs = uniqueValidKeys(Array.isArray(value.tabs) ? value.tabs : []).slice(
    0,
    MAX_STORED_TABS,
  );
  const active =
    typeof value.active === "string" && tabs.includes(value.active) ? value.active : null;
  return { tabs, active };
}

export function encodeThreadTabs(state: ThreadTabsState): string {
  return JSON.stringify({ tabs: state.tabs, active: state.active });
}

/**
 * The route now shows `key`. An open tab for it becomes active; otherwise it replaces the active
 * tab, or opens beside it when the user asked for a new tab.
 */
export function followThreadTabRoute(
  state: ThreadTabsState,
  key: ThreadTabKey,
  options: { readonly newTab: boolean },
): ThreadTabsState {
  if (state.tabs.includes(key)) {
    return state.active === key ? state : { tabs: state.tabs, active: key };
  }
  const activeIndex = state.active === null ? -1 : state.tabs.indexOf(state.active);
  if (activeIndex === -1) return { tabs: [...state.tabs, key], active: key };
  const tabs = [...state.tabs];
  if (options.newTab) tabs.splice(activeIndex + 1, 0, key);
  else tabs[activeIndex] = key;
  return { tabs, active: key };
}

/** Closes `key`. Closing the active tab activates its right neighbour, else its left one. */
export function closeThreadTab(
  state: ThreadTabsState,
  key: ThreadTabKey,
): { readonly state: ThreadTabsState; readonly activate: ThreadTabKey | null } {
  const index = state.tabs.indexOf(key);
  if (index === -1) return { state, activate: null };
  const tabs = state.tabs.filter((tab) => tab !== key);
  if (state.active !== key) return { state: { tabs, active: state.active }, activate: null };
  const neighbour = tabs[index] ?? tabs[index - 1] ?? null;
  return { state: { tabs, active: neighbour }, activate: neighbour };
}

/** The tab `delta` places from the active one, wrapping around. */
export function relativeThreadTab(state: ThreadTabsState, delta: number): ThreadTabKey | null {
  const count = state.tabs.length;
  if (count === 0) return null;
  const index = state.active === null ? -1 : state.tabs.indexOf(state.active);
  if (index === -1) return state.tabs[delta >= 0 ? 0 : count - 1] ?? null;
  return state.tabs[(((index + delta) % count) + count) % count] ?? null;
}

/** Tab N (0-based); like a browser, the ninth always means the last tab. */
export function threadTabAt(state: ThreadTabsState, index: number): ThreadTabKey | null {
  if (index >= 8) return state.tabs.at(-1) ?? null;
  return state.tabs[index] ?? null;
}

export function moveThreadTab(
  state: ThreadTabsState,
  key: ThreadTabKey,
  toIndex: number,
): ThreadTabsState {
  const from = state.tabs.indexOf(key);
  if (from === -1) return state;
  const target = Math.max(0, Math.min(state.tabs.length - 1, toIndex));
  if (target === from) return state;
  const tabs = state.tabs.filter((tab) => tab !== key);
  tabs.splice(target, 0, key);
  return { tabs, active: state.active };
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

/** Drops gone tabs and swaps sent drafts for their threads. The active tab is the route's, so it stays. */
export function pruneThreadTabs(
  state: ThreadTabsState,
  input: ThreadTabLivenessInput,
): ThreadTabsState {
  let changed = false;
  const resolved: ThreadTabKey[] = [];
  for (const tab of state.tabs) {
    const next = tab === state.active ? tab : resolveThreadTab(tab, input);
    if (next !== tab) changed = true;
    if (next !== null) resolved.push(next);
  }
  if (!changed) return state;
  const tabs = uniqueValidKeys(resolved);
  return {
    tabs,
    active: state.active !== null && tabs.includes(state.active) ? state.active : null,
  };
}
