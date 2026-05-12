import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "./types";
import { resolveStorage } from "./lib/storage";

export type BottomDrawerMode = "hidden" | "preview";

interface BottomDrawerUiStore {
  visibleMode: BottomDrawerMode;
  previousVisibleMode?: null | undefined;
  sharedHeight: number;
  isFullHeight: boolean;
  showPreview: () => void;
  closeVisibleMode: () => void;
  setSharedHeight: (height: number) => void;
  setFullHeight: (fullHeight: boolean) => void;
}

function createBottomDrawerStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useBottomDrawerUiStore = create<BottomDrawerUiStore>()(
  persist(
    (set) => ({
      visibleMode: "hidden",
      previousVisibleMode: null,
      sharedHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
      isFullHeight: false,
      showPreview: () =>
        set(() => ({
          visibleMode: "preview",
        })),
      closeVisibleMode: () =>
        set(() => ({
          visibleMode: "hidden",
        })),
      setSharedHeight: (height) =>
        set(() => ({
          isFullHeight: false,
          sharedHeight:
            Number.isFinite(height) && height > 0
              ? Math.round(height)
              : DEFAULT_THREAD_TERMINAL_HEIGHT,
        })),
      setFullHeight: (fullHeight) =>
        set(() => ({
          isFullHeight: fullHeight,
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
