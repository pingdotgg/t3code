import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MAX_TABS = 12;
const SEPARATOR = "\u001f";

/** A top-level tab: a thread, or a file or terminal that belongs to one, as in monocode. */
export type WorkspaceTab =
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "file"; readonly threadRef: ScopedThreadRef; readonly path: string }
  | { readonly kind: "terminal"; readonly threadRef: ScopedThreadRef; readonly terminalId: string };

export function fileTabKey(threadKey: string, path: string): string {
  return ["file", threadKey, path].join(SEPARATOR);
}

export function terminalTabKey(threadKey: string, terminalId: string): string {
  return ["terminal", threadKey, terminalId].join(SEPARATOR);
}

export function parseWorkspaceTab(key: string): WorkspaceTab | null {
  const [kind, threadKey, value] = key.split(SEPARATOR);
  if (value === undefined) {
    const threadRef = parseScopedThreadKey(key);
    return threadRef ? { kind: "thread", threadRef } : null;
  }
  const threadRef = threadKey ? parseScopedThreadKey(threadKey) : null;
  if (!threadRef || !value) return null;
  if (kind === "file") return { kind, threadRef, path: value };
  if (kind === "terminal") return { kind, threadRef, terminalId: value };
  return null;
}

export type WorkspaceSplitDirection = "right" | "down";

/** A second pane beside (right) or under (down) the routed thread, showing another open tab. */
export interface WorkspaceSplit {
  readonly key: string;
  readonly direction: WorkspaceSplitDirection;
  /** The routed pane's share of the space, 0..1. */
  readonly ratio: number;
}

interface WorkspaceTabsState {
  /** Tab keys, left to right. Per browser: each client keeps its own open set. */
  readonly keys: ReadonlyArray<string>;
  /** The open file or terminal tab shown over the routed thread, or null for the thread itself. */
  readonly surfaceKey: string | null;
  readonly split: WorkspaceSplit | null;
  open: (key: string) => void;
  /** Opens a file or terminal tab and shows it. */
  showSurface: (key: string) => void;
  hideSurface: () => void;
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
      surfaceKey: null,
      split: null,
      open: (key) =>
        set((state) =>
          state.keys.includes(key) ? state : { keys: [...state.keys, key].slice(-MAX_TABS) },
        ),
      showSurface: (key) =>
        set((state) => ({
          surfaceKey: key,
          keys: state.keys.includes(key) ? state.keys : [...state.keys, key].slice(-MAX_TABS),
        })),
      hideSurface: () => set((state) => (state.surfaceKey === null ? state : { surfaceKey: null })),
      close: (key) =>
        set((state) => ({
          keys: state.keys.filter((open) => open !== key),
          surfaceKey: state.surfaceKey === key ? null : state.surfaceKey,
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
