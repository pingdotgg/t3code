import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";

const STORAGE_KEY = "t3code:environment-glyphs:v1";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const fallbackStorage = createMemoryStorage();

// Privacy modes and quotas can deny storage writes. Retain in-memory edits.
const safeStorage = {
  getItem: (name: string) => {
    try {
      return typeof window === "undefined"
        ? fallbackStorage.getItem(name)
        : window.localStorage.getItem(name);
    } catch {
      return fallbackStorage.getItem(name);
    }
  },
  setItem: (name: string, value: string) => {
    try {
      if (typeof window === "undefined") fallbackStorage.setItem(name, value);
      else window.localStorage.setItem(name, value);
    } catch {
      fallbackStorage.setItem(name, value);
    }
  },
  removeItem: (name: string) => {
    try {
      if (typeof window === "undefined") fallbackStorage.removeItem(name);
      else window.localStorage.removeItem(name);
    } catch {
      fallbackStorage.removeItem(name);
    }
  },
};

/** One visible character, including combining marks and multi-codepoint emoji. */
export function normalizeEnvironmentGlyph(value: string): string | null {
  const [first] = graphemes.segment(value.trim());
  return first?.segment ?? null;
}

interface EnvironmentGlyphState {
  readonly byId: Partial<Record<EnvironmentId, string>>;
  readonly setGlyph: (environmentId: EnvironmentId, value: string) => void;
}

export const useEnvironmentGlyphStore = create<EnvironmentGlyphState>()(
  persist(
    (set) => ({
      byId: {},
      setGlyph: (environmentId, value) =>
        set((state) => {
          const glyph = normalizeEnvironmentGlyph(value);
          if ((state.byId[environmentId] ?? null) === glyph) return state;

          const byId = { ...state.byId };
          if (glyph === null) delete byId[environmentId];
          else byId[environmentId] = glyph;
          return { byId };
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ byId: state.byId }),
    },
  ),
);
