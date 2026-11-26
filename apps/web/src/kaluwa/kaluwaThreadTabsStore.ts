// Fork: the open titlebar tabs, kept in memory per window and saved to localStorage so they come
// back after a restart. Each window keeps its own tabs while it runs; the last one to change
// them is what the next launch restores.
import { useSyncExternalStore } from "react";

import {
  EMPTY_THREAD_TABS,
  decodeThreadTabs,
  encodeThreadTabs,
  followThreadTabRoute,
  type ThreadTabKey,
  type ThreadTabsState,
} from "./kaluwaThreadTabs.logic";

const STORAGE_KEY = "kaluwa:thread-tabs:v1";
// A "+" or middle-click arms the next route change to open a tab instead of replacing one. The
// arm expires so a navigation that never happens cannot hijack a later sidebar click.
const NEW_TAB_ARM_MS = 5_000;

const listeners = new Set<() => void>();
let state: ThreadTabsState | null = null;
let newTabArmedUntil = 0;

export function readThreadTabs(): ThreadTabsState {
  if (state !== null) return state;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {}
  state = decodeThreadTabs(raw);
  return state;
}

export function writeThreadTabs(next: ThreadTabsState): void {
  if (next === state) return;
  state = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, encodeThreadTabs(next));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

export function armNewThreadTab(): void {
  newTabArmedUntil = Date.now() + NEW_TAB_ARM_MS;
}

export function disarmNewThreadTab(): void {
  newTabArmedUntil = 0;
}

/** The route shows `key` now; `current` is the pruned tab list it applies to. */
export function applyThreadTabRoute(current: ThreadTabsState, key: ThreadTabKey): void {
  const newTab = Date.now() < newTabArmedUntil;
  newTabArmedUntil = 0;
  writeThreadTabs(followThreadTabRoute(current, key, { newTab }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStoredThreadTabs(): ThreadTabsState {
  return useSyncExternalStore(subscribe, readThreadTabs, () => EMPTY_THREAD_TABS);
}
