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
  const activeId =
    id === tabs.activeId ? (ids[ids.length - 1] as string) : tabs.activeId;
  return { ids, activeId };
}

/** The id `delta` steps from the active one, wrapping around. */
export function cycleActiveId(tabs: ThreadTabs, delta: 1 | -1): string {
  if (tabs.ids.length < 2) return tabs.activeId;
  const index = tabs.ids.indexOf(tabs.activeId);
  const nextIndex = (index + delta + tabs.ids.length) % tabs.ids.length;
  return tabs.ids[nextIndex] as string;
}
