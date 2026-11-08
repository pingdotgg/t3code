import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MAX_TABS = 12;

export type WorkspaceSplitDirection = "right" | "down";

/** A second pane beside (right) or under (down) the routed thread, showing another open tab. */
export interface WorkspaceSplit {
  readonly key: string;
  readonly direction: WorkspaceSplitDirection;
  /** The routed pane's share of the space, 0..1. */
  readonly ratio: number;
}

interface WorkspaceTabsState {
  /** Scoped thread keys, left to right. Per browser: each client keeps its own open set. */
  readonly keys: ReadonlyArray<string>;
  readonly split: WorkspaceSplit | null;
  open: (key: string) => void;
  close: (key: string) => void;
  openSplit: (key: string, direction: WorkspaceSplitDirection) => void;
  /** Shows `key` in the split pane, keeping its direction and size. */
  setSplitKey: (key: string) => void;
  setSplitRatio: (ratio: number) => void;
  closeSplit: () => void;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set) => ({
      keys: [],
      split: null,
      open: (key) =>
        set((state) =>
          state.keys.includes(key) ? state : { keys: [...state.keys, key].slice(-MAX_TABS) },
        ),
      close: (key) =>
        set((state) => ({
          keys: state.keys.filter((open) => open !== key),
          split: state.split?.key === key ? null : state.split,
        })),
      openSplit: (key, direction) =>
        set((state) => ({
          keys: state.keys.includes(key) ? state.keys : [...state.keys, key].slice(-MAX_TABS),
          split: { key, direction, ratio: state.split?.ratio ?? 0.5 },
        })),
      setSplitKey: (key) =>
        set((state) => (state.split ? { split: { ...state.split, key } } : state)),
      setSplitRatio: (ratio) =>
        set((state) =>
          state.split ? { split: { ...state.split, ratio: clampSplitRatio(ratio) } } : state,
        ),
      closeSplit: () => set({ split: null }),
    }),
    {
      name: "t3code:workspace-tabs:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ keys: state.keys, split: state.split }),
    },
  ),
);

/** The tab to show after closing `key`: its right neighbor, else its left one. */
export function neighborTabKey(keys: ReadonlyArray<string>, key: string): string | null {
  const index = keys.indexOf(key);
  if (index === -1) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}

const MIN_SPLIT_RATIO = 0.2;
const SPLIT_SNAPS = [1 / 3, 1 / 2, 2 / 3];
/** How close, in pixels, a dragged handle must come to a snap spot to take it. */
const SPLIT_SNAP_PX = 12;

function clampSplitRatio(ratio: number): number {
  return Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/** Where a handle dragged to `ratio` of a `sizePx` container rests: a nearby snap spot, else `ratio`. */
export function snapSplitRatio(ratio: number, sizePx: number): { ratio: number; snapped: boolean } {
  const snap = SPLIT_SNAPS.find((spot) => Math.abs(spot - ratio) * sizePx <= SPLIT_SNAP_PX);
  return snap === undefined
    ? { ratio: clampSplitRatio(ratio), snapped: false }
    : { ratio: snap, snapped: true };
}
