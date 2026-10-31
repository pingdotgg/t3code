import type { RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

// TanStack stamps __TSR_index; sessionStorage tracks the furthest entry for forward navigation.
// Pushing truncates forward history. Reloads retain it; fresh page loads reset it.
// Restamp entries after raw history writes, such as stripping a pairing token, lose the router index.
const FURTHEST_INDEX_STORAGE_KEY = "t3code:navigation-furthest-index";

export type HistoryDirection = "back" | "forward";

let currentIndex = 0;
let furthestIndex = 0;
const listeners = new Set<() => void>();

function readStampedIndex(state: { __TSR_index?: unknown } | null | undefined): number | null {
  const index = state?.__TSR_index;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}

// Writes the index into the current entry. The router's patched replaceState
// re-reads the location, so its next push counts from this index.
function stampCurrentEntry(index: number) {
  const state = window.history.state as Record<string, unknown> | null;
  if (readStampedIndex(state) === index) return;
  const key =
    typeof state?.__TSR_key === "string" ? state.__TSR_key : Math.random().toString(36).slice(2, 7);
  window.history.replaceState({ ...state, key, __TSR_key: key, __TSR_index: index }, "");
}

function readStoredFurthestIndex(): number {
  try {
    const stored = Number(window.sessionStorage.getItem(FURTHEST_INDEX_STORAGE_KEY));
    return Number.isInteger(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function writeStoredFurthestIndex(index: number) {
  try {
    window.sessionStorage.setItem(FURTHEST_INDEX_STORAGE_KEY, String(index));
  } catch {
    // Without storage, forward stays available only until the next reload.
  }
}

// A "navigate" load is a new history entry, so nothing sits past it.
function isFreshHistoryEntry(): boolean {
  const [entry] = performance.getEntriesByType("navigation");
  return !entry || !("type" in entry) || entry.type === "navigate";
}

/** Starts tracking at boot, before the first route navigation. */
export function trackNavigationHistory(history: RouterHistory): () => void {
  const bootIndex = readStampedIndex(history.location.state);
  currentIndex = bootIndex ?? 0;
  if (bootIndex === null) stampCurrentEntry(0);
  furthestIndex =
    bootIndex === null || isFreshHistoryEntry()
      ? currentIndex
      : Math.max(currentIndex, readStoredFurthestIndex());
  writeStoredFurthestIndex(furthestIndex);

  return history.subscribe(({ action }) => {
    const stamped = readStampedIndex(history.location.state);
    // A push always lands one past the current entry, and a replace keeps it.
    // An entry that says otherwise was written around the router.
    const expected =
      action.type === "PUSH" ? currentIndex + 1 : action.type === "REPLACE" ? currentIndex : null;
    const nextIndex = expected ?? stamped ?? currentIndex;
    if (stamped !== nextIndex) {
      // Router pushes reach window.history in a microtask; stamp after them.
      queueMicrotask(() => stampCurrentEntry(nextIndex));
    }
    const nextFurthestIndex =
      action.type === "PUSH" ? nextIndex : Math.max(furthestIndex, nextIndex);
    if (nextIndex === currentIndex && nextFurthestIndex === furthestIndex) return;
    currentIndex = nextIndex;
    if (nextFurthestIndex !== furthestIndex) {
      furthestIndex = nextFurthestIndex;
      writeStoredFurthestIndex(furthestIndex);
    }
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function canNavigateHistory(direction: HistoryDirection): boolean {
  return direction === "back" ? currentIndex > 0 : currentIndex < furthestIndex;
}

/** Moves one app entry back or forward; never past the app's first or last entry. */
export function navigateHistory(direction: HistoryDirection): boolean {
  if (!canNavigateHistory(direction)) return false;
  if (direction === "back") window.history.back();
  else window.history.forward();
  return true;
}

export function useCanNavigateHistory(direction: HistoryDirection): boolean {
  return useSyncExternalStore(subscribe, () => canNavigateHistory(direction));
}
