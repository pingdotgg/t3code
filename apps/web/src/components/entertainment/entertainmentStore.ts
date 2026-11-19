import { create } from "zustand";
import { persist } from "zustand/middleware";

export const ENTERTAINMENT_MIN_WIDTH = 264;
export const ENTERTAINMENT_MAX_WIDTH = 720;

interface Favorite {
  readonly title: string;
  readonly url: string;
}

interface EntertainmentState {
  readonly open: boolean;
  readonly dock: "left" | "right";
  readonly width: number;
  readonly favorites: ReadonlyArray<Favorite>;
  readonly toggle: () => void;
  readonly setDock: (dock: "left" | "right") => void;
  readonly resize: (width: number) => void;
  readonly addFavorite: (favorite: Favorite) => void;
  readonly removeFavorite: (url: string) => void;
}

export const useEntertainmentStore = create<EntertainmentState>()(
  persist(
    (set) => ({
      open: false,
      dock: "right",
      width: 360,
      favorites: [],
      toggle: () => set((state) => ({ open: !state.open })),
      setDock: (dock) => set({ dock }),
      resize: (width) =>
        set({ width: Math.min(ENTERTAINMENT_MAX_WIDTH, Math.max(ENTERTAINMENT_MIN_WIDTH, width)) }),
      addFavorite: (favorite) =>
        set((state) => ({
          favorites: [...state.favorites.filter((entry) => entry.url !== favorite.url), favorite],
        })),
      removeFavorite: (url) =>
        set((state) => ({
          favorites: state.favorites.filter((entry) => entry.url !== url),
        })),
    }),
    {
      name: "continuum-entertainment",
      partialize: ({ dock, width, favorites }) => ({ dock, width, favorites }),
    },
  ),
);
