import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "./types";
import { resolveStorage } from "./lib/storage";

export type BottomDrawerMode = "hidden" | "terminal" | "preview";

interface BottomDrawerUiStore {
  visibleMode: BottomDrawerMode;
  previousVisibleMode: Exclude<BottomDrawerMode, "hidden"> | null;
  sharedHeight: number;
  showTerminal: () => void;
  showPreview: () => void;
  closeVisibleMode: () => void;
  setSharedHeight: (height: number) => void;
}

function createBottomDrawerStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function withPreviousMode(
  currentMode: BottomDrawerMode,
  nextMode: Exclude<BottomDrawerMode, "hidden">,
): Exclude<BottomDrawerMode, "hidden"> | null {
  return currentMode === "hidden" || currentMode === nextMode ? null : currentMode;
}

export const useBottomDrawerUiStore = create<BottomDrawerUiStore>()(
  persist(
    (set) => ({
      visibleMode: "hidden",
      previousVisibleMode: null,
      sharedHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
      showTerminal: () =>
        set((state) => ({
          visibleMode: "terminal",
          previousVisibleMode: withPreviousMode(state.visibleMode, "terminal"),
        })),
      showPreview: () =>
        set((state) => ({
          visibleMode: "preview",
          previousVisibleMode: withPreviousMode(state.visibleMode, "preview"),
        })),
      closeVisibleMode: () =>
        set((state) => {
          if (state.visibleMode === "preview" && state.previousVisibleMode === "terminal") {
            return {
              visibleMode: "terminal",
              previousVisibleMode: null,
            };
          }
          return {
            visibleMode: "hidden",
            previousVisibleMode:
              state.visibleMode === "hidden" ? state.previousVisibleMode : state.visibleMode,
          };
        }),
      setSharedHeight: (height) =>
        set(() => ({
          sharedHeight:
            Number.isFinite(height) && height > 0
              ? Math.round(height)
              : DEFAULT_THREAD_TERMINAL_HEIGHT,
        })),
    }),
    {
      name: "forma:bottom-drawer-ui:v1",
      storage: createJSONStorage(createBottomDrawerStorage),
      partialize: (state) => ({
        sharedHeight: state.sharedHeight,
      }),
    },
  ),
);
