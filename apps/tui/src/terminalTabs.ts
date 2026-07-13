import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";

// Pure per-thread terminal-tab transitions (the TUI's form of the web's terminal
// groups). ChatView owns the side effects (open/close server sessions, focus);
// the tab-list math lives here so it's unit-tested without a renderer.

/** A thread's open terminal tabs: client-chosen ids + the active one. */
export interface ThreadTabs {
  readonly ids: ReadonlyArray<string>;
  readonly activeId: string;
}

/** The next free `term-N` id given a thread's existing ids. */
export function nextTerminalId(ids: ReadonlyArray<string>): string {
  let max = 0;
  for (const id of ids) {
    const match = /^term-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `term-${max + 1}`;
}

/** The initial single-tab state when a thread's terminal is first opened. */
export function initialTabs(): ThreadTabs {
  return { ids: [DEFAULT_TERMINAL_ID], activeId: DEFAULT_TERMINAL_ID };
}

/** Append a fresh terminal and make it active (first one reuses the default id). */
export function addTab(tabs: ThreadTabs | null): ThreadTabs {
  const ids = tabs?.ids ?? [];
  const id = ids.length === 0 ? DEFAULT_TERMINAL_ID : nextTerminalId(ids);
  return { ids: [...ids, id], activeId: id };
}

/**
 * Remove a tab, falling back to the last remaining tab when the active one was
 * closed. Returns null when the last tab is closed (the drawer should close).
 */
export function closeTab(tabs: ThreadTabs, id: string): ThreadTabs | null {
  const ids = tabs.ids.filter((existing) => existing !== id);
  if (ids.length === 0) return null;
  const activeId = id === tabs.activeId ? (ids[ids.length - 1] as string) : tabs.activeId;
  return { ids, activeId };
}

/** The id `delta` steps from the active one, wrapping around. */
export function cycleActiveId(tabs: ThreadTabs, delta: 1 | -1): string {
  if (tabs.ids.length < 2) return tabs.activeId;
  const index = tabs.ids.indexOf(tabs.activeId);
  const nextIndex = (index + delta + tabs.ids.length) % tabs.ids.length;
  return tabs.ids[nextIndex] as string;
}

/** Numeric-aware compare for `term-N` ids so `term-2` sorts before `term-10`. */
function compareTerminalIds(a: string, b: string): number {
  const na = /^term-(\d+)$/.exec(a);
  const nb = /^term-(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a.localeCompare(b);
}

/**
 * Union server-discovered terminal ids into a thread's tab list so the TUI
 * reflects sessions the agent, the web client, or a prior run created — not just
 * the tabs this TUI opened. Existing ids and the active tab are preserved; new
 * ids are appended and the list is kept in stable numeric order. When there are
 * no local tabs yet, the discovered ids seed a fresh list.
 */
export function tabsWithDiscovered(
  tabs: ThreadTabs | null,
  discoveredIds: ReadonlyArray<string>,
): ThreadTabs | null {
  if (discoveredIds.length === 0) return tabs;
  const merged = [...(tabs?.ids ?? [])];
  for (const id of discoveredIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  merged.sort(compareTerminalIds);
  const activeId = tabs?.activeId ?? (merged[0] as string);
  // Nothing new? Return the original reference so callers can skip a state write.
  if (tabs && merged.length === tabs.ids.length) return tabs;
  return { ids: merged, activeId };
}

/** A terminal-metadata stream event (snapshot | upsert | remove) from the server. */
export type TerminalMetadataEvent =
  | {
      readonly type: "snapshot";
      readonly terminals: ReadonlyArray<{ readonly threadId: string; readonly terminalId: string }>;
    }
  | {
      readonly type: "upsert";
      readonly terminal: { readonly threadId: string; readonly terminalId: string };
    }
  | { readonly type: "remove"; readonly threadId: string; readonly terminalId: string };

/**
 * Fold a terminal-metadata event into the per-thread map of known terminal ids.
 * A snapshot replaces the whole map; upsert/remove adjust one thread's set. The
 * result feeds {@link tabsWithDiscovered}. Removals are tracked so a closed
 * terminal stops being re-added, but never force-close a tab the user is on —
 * that stays the drawer's decision.
 */
export function reduceKnownTerminals(
  previous: ReadonlyMap<string, ReadonlyArray<string>>,
  event: TerminalMetadataEvent,
): ReadonlyMap<string, ReadonlyArray<string>> {
  if (event.type === "snapshot") {
    const next = new Map<string, string[]>();
    for (const { threadId, terminalId } of event.terminals) {
      const ids = next.get(threadId) ?? [];
      if (!ids.includes(terminalId)) ids.push(terminalId);
      next.set(threadId, ids);
    }
    return next;
  }
  const next = new Map<string, ReadonlyArray<string>>(previous);
  if (event.type === "upsert") {
    const { threadId, terminalId } = event.terminal;
    const ids = next.get(threadId) ?? [];
    if (!ids.includes(terminalId)) next.set(threadId, [...ids, terminalId]);
    return next;
  }
  const ids = (next.get(event.threadId) ?? []).filter((id) => id !== event.terminalId);
  if (ids.length === 0) next.delete(event.threadId);
  else next.set(event.threadId, ids);
  return next;
}
