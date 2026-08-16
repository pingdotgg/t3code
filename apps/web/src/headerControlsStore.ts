import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

export interface HeaderControlsVisibility {
  scripts: boolean;
  openIn: boolean;
  git: boolean;
}

export interface HeaderControlsStoreState {
  visibility: HeaderControlsVisibility;
  toggleControl: (control: keyof HeaderControlsVisibility) => void;
  setControlVisibility: (control: keyof HeaderControlsVisibility, visible: boolean) => void;
  resetVisibility: () => void;
}

const DEFAULT_VISIBILITY: HeaderControlsVisibility = {
  scripts: true,
  openIn: true,
  git: true,
};

export const useHeaderControlsStore = create<HeaderControlsStoreState>()(
  persist(
    (set) => ({
      visibility: DEFAULT_VISIBILITY,
      toggleControl: (control) =>
        set((state) => ({
          visibility: {
            ...state.visibility,
            [control]: !state.visibility[control],
          },
        })),
      setControlVisibility: (control, visible) =>
        set((state) => ({
          visibility: {
            ...state.visibility,
            [control]: visible,
          },
        })),
      resetVisibility: () => set({ visibility: DEFAULT_VISIBILITY }),
    }),
    {
      name: "t3code:header-controls:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
