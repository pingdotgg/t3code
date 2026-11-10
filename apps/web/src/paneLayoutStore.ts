import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import {
  EMPTY_PANE_LAYOUT,
  MAX_PANES,
  addPane,
  closePane,
  focusPane,
  followRoute,
  paneRowCounts,
  replacePane,
  resizeBoundary,
  resolvePaneSizes,
  type Pane,
  type PaneLayout,
  swapPanes,
  type PaneSizes,
} from "./paneLayout";

const PANE_LAYOUT_STORAGE_KEY = "t3code:pane-layout:v1";
const PANE_LAYOUT_STORAGE_VERSION = 1;

interface PaneLayoutStoreState extends PaneLayout {
  /** Saved divider positions; null, or sized for another pane count, means equal panes. */
  sizes: PaneSizes | null;
  /** Start a split from `current`, or add to one. A thread already open is focused instead. */
  addPane: (current: ScopedThreadRef | null, ref: ScopedThreadRef) => void;
  replacePane: (index: number, ref: ScopedThreadRef) => void;
  closePane: (index: number) => void;
  /** Exchange the conversations in two slots, as when one pane is dragged onto another. */
  swapPanes: (from: number, to: number) => void;
  focusPane: (index: number) => void;
  followRoute: (ref: ScopedThreadRef) => void;
  /** Drop every pane that shows `ref`, for a thread that no longer exists. */
  removeThread: (ref: ScopedThreadRef) => void;
  /** Drag the boundary between row `index` and the next, as a fraction of the grid height. */
  resizeRows: (count: number, index: number, delta: number, min: number) => void;
  /** Drag the boundary between pane `index` and the next in `row`, as a fraction of its width. */
  resizeCols: (count: number, row: number, index: number, delta: number, min: number) => void;
  resetSizes: () => void;
  reset: () => void;
}

let paneIdCounter = 0;
function newPaneId(): string {
  paneIdCounter += 1;
  return `pane-${Date.now().toString(36)}-${paneIdCounter}`;
}

function layoutOf(state: PaneLayout): PaneLayout {
  return { panes: state.panes, focusedIndex: state.focusedIndex };
}

export const usePaneLayoutStore = create<PaneLayoutStoreState>()(
  persist(
    (set, get) => ({
      ...EMPTY_PANE_LAYOUT,
      sizes: null,
      addPane: (current, ref) => set(addPane(layoutOf(get()), current, ref, newPaneId)),
      replacePane: (index, ref) => set(replacePane(layoutOf(get()), index, ref, newPaneId)),
      closePane: (index) => set(closePane(layoutOf(get()), index)),
      swapPanes: (from, to) => set(swapPanes(layoutOf(get()), from, to)),
      focusPane: (index) => {
        const next = focusPane(layoutOf(get()), index);
        if (next.focusedIndex !== get().focusedIndex) set(next);
      },
      followRoute: (ref) => {
        const state = get();
        const next = followRoute(layoutOf(state), ref);
        if (next.panes !== state.panes || next.focusedIndex !== state.focusedIndex) set(next);
      },
      removeThread: (ref) => {
        const key = scopedThreadKey(ref);
        let layout = layoutOf(get());
        for (let index = layout.panes.length - 1; index >= 0; index -= 1) {
          if (scopedThreadKey(layout.panes[index]!.ref) === key) {
            layout = closePane(layout, index);
          }
        }
        set(layout);
      },
      resizeRows: (count, index, delta, min) =>
        set((state) => {
          const sizes = resolvePaneSizes(state.sizes, count);
          return { sizes: { ...sizes, rows: resizeBoundary(sizes.rows, index, delta, min) } };
        }),
      resizeCols: (count, row, index, delta, min) =>
        set((state) => {
          const sizes = resolvePaneSizes(state.sizes, count);
          const cols = sizes.cols.map((fractions, i) =>
            i === row ? resizeBoundary(fractions, index, delta, min) : fractions,
          );
          return { sizes: { ...sizes, cols } };
        }),
      resetSizes: () => set({ sizes: null }),
      reset: () => set({ ...EMPTY_PANE_LAYOUT, sizes: null }),
    }),
    {
      name: PANE_LAYOUT_STORAGE_KEY,
      version: PANE_LAYOUT_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ ...layoutOf(state), sizes: state.sizes }),
      merge: (persisted, current) => {
        const layout = sanitizePersistedLayout(persisted);
        const sizes = (persisted as { sizes?: unknown } | null)?.sizes;
        return { ...current, ...layout, sizes: sanitizePersistedSizes(sizes, layout.panes.length) };
      },
    },
  ),
);

/** Storage is user-editable and survives upgrades, so keep only well-formed panes. */
export function sanitizePersistedLayout(value: unknown): PaneLayout {
  if (typeof value !== "object" || value === null) return EMPTY_PANE_LAYOUT;
  const { panes, focusedIndex } = value as { panes?: unknown; focusedIndex?: unknown };
  if (!Array.isArray(panes)) return EMPTY_PANE_LAYOUT;
  const seen = new Set<string>();
  const clean: Pane[] = [];
  for (const entry of panes) {
    if (clean.length >= MAX_PANES) break;
    const { id, ref } = (entry ?? {}) as { id?: unknown; ref?: Partial<ScopedThreadRef> };
    if (typeof id !== "string" || typeof ref?.environmentId !== "string") continue;
    if (typeof ref.threadId !== "string") continue;
    const threadRef = {
      environmentId: EnvironmentId.make(ref.environmentId),
      threadId: ThreadId.make(ref.threadId),
    };
    const key = scopedThreadKey(threadRef);
    if (seen.has(key) || clean.some((pane) => pane.id === id)) continue;
    seen.add(key);
    clean.push({ id, ref: threadRef });
  }
  const focus =
    typeof focusedIndex === "number" && Number.isInteger(focusedIndex) ? focusedIndex : 0;
  return { panes: clean, focusedIndex: Math.max(0, Math.min(focus, clean.length - 1)) };
}

// A lone row or column is exactly 1; the sum check below rejects 1 anywhere else.
const isFraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;

/** Keep saved divider positions only if they still describe the grid for `count` panes. */
export function sanitizePersistedSizes(value: unknown, count: number): PaneSizes | null {
  if (typeof value !== "object" || value === null) return null;
  const { count: savedCount, rows, cols } = value as Partial<Record<keyof PaneSizes, unknown>>;
  if (savedCount !== count || !Array.isArray(rows) || !Array.isArray(cols)) return null;
  const rowCounts = paneRowCounts(count);
  const sumsToOne = (fractions: ReadonlyArray<number>) =>
    Math.abs(fractions.reduce((a, b) => a + b, 0) - 1) < 1e-6;
  if (rows.length !== rowCounts.length || !rows.every(isFraction) || !sumsToOne(rows)) return null;
  if (cols.length !== rowCounts.length) return null;
  for (const [i, row] of cols.entries()) {
    const valid = Array.isArray(row) && row.length === rowCounts[i] && row.every(isFraction);
    if (!valid || !sumsToOne(row as number[])) return null;
  }
  return { count, rows, cols: cols as number[][] };
}
