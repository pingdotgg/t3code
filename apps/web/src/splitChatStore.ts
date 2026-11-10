import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { ThreadRouteTarget } from "./threadRoutes";

export const MAX_SPLIT_CHATS = 4;

interface SplitChatPersisted {
  readonly horizontalRatio: number;
  readonly verticalRatio: number;
  readonly topRowRatio: number;
  readonly bottomRowRatio: number;
  readonly rightColumnRatio: number;
  readonly resizeLayout: "rows" | "columns";
}

export function threadTargetKey(target: ThreadRouteTarget | null | undefined): string {
  if (!target) return "";
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : `draft:${target.draftId}`;
}

interface SplitChatState {
  readonly secondaryPanes: readonly ThreadRouteTarget[];
  readonly activePaneIndex: number;

  readonly horizontalRatio: number;
  readonly verticalRatio: number;
  readonly topRowRatio: number;
  readonly bottomRowRatio: number;
  readonly rightColumnRatio: number;
  readonly resizeLayout: "rows" | "columns";

  readonly openToSide: (target: ThreadRouteTarget, primary?: ThreadRouteTarget | null) => boolean;
  readonly replaceSecondaryPanes: (
    panes: readonly ThreadRouteTarget[],
    activeIndex: number,
  ) => void;
  readonly setActivePane: (index: number) => void;
  readonly setHorizontalRatio: (ratio: number) => void;
  readonly setVerticalRatio: (ratio: number) => void;
  readonly setTopRowRatio: (ratio: number) => void;
  readonly setBottomRowRatio: (ratio: number) => void;
  readonly setRightColumnRatio: (ratio: number) => void;
  readonly setResizeLayout: (layout: "rows" | "columns") => void;
}

const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function clampRatio(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_RATIO;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, val));
}

export const useSplitChatStore = create<SplitChatState>()(
  persist(
    (set, get) => ({
      secondaryPanes: [],
      activePaneIndex: 0,
      horizontalRatio: DEFAULT_RATIO,
      verticalRatio: DEFAULT_RATIO,
      topRowRatio: DEFAULT_RATIO,
      bottomRowRatio: DEFAULT_RATIO,
      rightColumnRatio: DEFAULT_RATIO,
      resizeLayout: "rows",

      openToSide: (target, primary) => {
        const state = get();
        const targetKey = threadTargetKey(target);
        if (!targetKey) return false;
        if (targetKey === threadTargetKey(primary)) {
          set({ activePaneIndex: 0 });
          return true;
        }

        const existingIndex = state.secondaryPanes.findIndex(
          (pane) => threadTargetKey(pane) === targetKey,
        );
        if (existingIndex !== -1) {
          set({ activePaneIndex: existingIndex + 1 });
          return true;
        }

        if (state.secondaryPanes.length >= MAX_SPLIT_CHATS - 1) {
          return false;
        }

        const newPanes = [...state.secondaryPanes, target];
        set({
          secondaryPanes: newPanes,
          activePaneIndex: newPanes.length,
        });
        return true;
      },

      replaceSecondaryPanes: (secondaryPanes, activePaneIndex) => {
        set({ secondaryPanes: secondaryPanes.slice(0, MAX_SPLIT_CHATS - 1), activePaneIndex });
      },

      setActivePane: (index: number) => {
        set({ activePaneIndex: index });
      },

      setHorizontalRatio: (ratio: number) => {
        set({ horizontalRatio: clampRatio(ratio) });
      },

      setVerticalRatio: (ratio: number) => {
        set({ verticalRatio: clampRatio(ratio) });
      },

      setTopRowRatio: (ratio: number) => {
        set({ topRowRatio: clampRatio(ratio) });
      },

      setBottomRowRatio: (ratio: number) => {
        set({ bottomRowRatio: clampRatio(ratio) });
      },

      setRightColumnRatio: (ratio) => set({ rightColumnRatio: clampRatio(ratio) }),
      setResizeLayout: (resizeLayout) => set({ resizeLayout }),
    }),
    {
      name: "t3code:split-chat:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SplitChatPersisted>;
        return {
          ...current,
          horizontalRatio: clampRatio(saved.horizontalRatio ?? DEFAULT_RATIO),
          verticalRatio: clampRatio(saved.verticalRatio ?? DEFAULT_RATIO),
          topRowRatio: clampRatio(saved.topRowRatio ?? DEFAULT_RATIO),
          bottomRowRatio: clampRatio(saved.bottomRowRatio ?? DEFAULT_RATIO),
          rightColumnRatio: clampRatio(saved.rightColumnRatio ?? DEFAULT_RATIO),
          resizeLayout: saved.resizeLayout === "columns" ? "columns" : "rows",
        };
      },
      partialize: (state): SplitChatPersisted => ({
        horizontalRatio: state.horizontalRatio,
        verticalRatio: state.verticalRatio,
        topRowRatio: state.topRowRatio,
        bottomRowRatio: state.bottomRowRatio,
        rightColumnRatio: state.rightColumnRatio,
        resizeLayout: state.resizeLayout,
      }),
    },
  ),
);
