import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import type { CustomSite } from "./entertainmentCatalog";

export const ENTERTAINMENT_BACKGROUNDS = [
  {
    id: "aurora",
    label: "Aurora",
    css: "radial-gradient(120% 90% at 10% 0%, #1e3a8a 0%, transparent 60%), radial-gradient(90% 80% at 100% 20%, #6d28d9 0%, transparent 55%), #050816",
  },
  {
    id: "sunset",
    label: "Sunset",
    css: "radial-gradient(120% 90% at 0% 100%, #be123c 0%, transparent 55%), radial-gradient(100% 80% at 100% 0%, #f59e0b 0%, transparent 50%), #120709",
  },
  {
    id: "ocean",
    label: "Ocean",
    css: "radial-gradient(120% 90% at 50% 120%, #0e7490 0%, transparent 60%), radial-gradient(80% 60% at 0% 0%, #1d4ed8 0%, transparent 55%), #020617",
  },
  {
    id: "forest",
    label: "Forest",
    css: "radial-gradient(120% 90% at 100% 100%, #15803d 0%, transparent 55%), radial-gradient(80% 60% at 0% 0%, #0f766e 0%, transparent 55%), #03100a",
  },
  { id: "midnight", label: "Midnight", css: "#05060a" },
] as const;
export type EntertainmentBackgroundId = (typeof ENTERTAINMENT_BACKGROUNDS)[number]["id"];

export interface RecentEntry {
  readonly id: string;
  readonly at: number;
}

interface EntertainmentState {
  readonly favorites: ReadonlyArray<string>;
  readonly order: ReadonlyArray<string>;
  readonly recents: ReadonlyArray<RecentEntry>;
  readonly customSites: ReadonlyArray<CustomSite>;
  readonly background: EntertainmentBackgroundId;
  /** What was open when the panel closed, reopened next time. */
  readonly lastOpen: string | null;
  readonly toggleFavorite: (id: string) => void;
  readonly setOrder: (order: ReadonlyArray<string>) => void;
  readonly recordOpen: (id: string) => void;
  readonly setLastOpen: (id: string | null) => void;
  readonly addCustomSite: (site: CustomSite) => void;
  readonly removeCustomSite: (id: string) => void;
  readonly setBackground: (background: EntertainmentBackgroundId) => void;
}

const RECENT_LIMIT = 8;

export const useEntertainmentStore = create<EntertainmentState>()(
  persist(
    (set) => ({
      favorites: [],
      order: [],
      recents: [],
      customSites: [],
      background: "aurora",
      lastOpen: null,
      toggleFavorite: (id) =>
        set((state) => ({
          favorites: state.favorites.includes(id)
            ? state.favorites.filter((entry) => entry !== id)
            : [...state.favorites, id],
        })),
      setOrder: (order) => set({ order }),
      recordOpen: (id) =>
        set((state) => ({
          recents: [
            { id, at: Date.now() },
            ...state.recents.filter((entry) => entry.id !== id),
          ].slice(0, RECENT_LIMIT),
        })),
      setLastOpen: (lastOpen) => set({ lastOpen }),
      addCustomSite: (site) =>
        set((state) => ({
          customSites: [...state.customSites.filter((s) => s.id !== site.id), site],
        })),
      removeCustomSite: (id) =>
        set((state) => ({
          customSites: state.customSites.filter((site) => site.id !== id),
          favorites: state.favorites.filter((entry) => entry !== id),
          recents: state.recents.filter((entry) => entry.id !== id),
        })),
      setBackground: (background) => set({ background }),
    }),
    {
      name: "continuum:entertainment:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        favorites: state.favorites,
        order: state.order,
        recents: state.recents,
        customSites: state.customSites,
        background: state.background,
        lastOpen: state.lastOpen,
      }),
    },
  ),
);

/** Game saves live in this device's storage under their own keys. */
export function readGameSave(key: string): string | null {
  try {
    return window.localStorage.getItem(`continuum:game:${key}`);
  } catch {
    return null;
  }
}

export function writeGameSave(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(`continuum:game:${key}`);
    else window.localStorage.setItem(`continuum:game:${key}`, value);
  } catch {
    // Storage full or disabled; the game keeps running unsaved.
  }
}
