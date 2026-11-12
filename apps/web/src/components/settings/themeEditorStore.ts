import { create } from "zustand";

import {
  getThemeDefinition,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../../themePalette";

export type ThemeEditorSessionInput = {
  editingThemeId: string | null;
  seedThemeId: string | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  id: number;
};

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  closeThemeEditor: () => void;
};

let nextSessionId = 0;

export const useThemeEditorStore = create<ThemeEditorStore>((set) => ({
  session: null,
  openThemeEditor: (session) => set({ session: { ...session, id: ++nextSessionId } }),
  closeThemeEditor: () => set({ session: null }),
}));

export function toggleThemeEditorForTheme(input: {
  theme: ThemePreference;
  themeHalves: ThemeHalves | null;
  initialAppearance: ThemeAppearance;
}): void {
  const store = useThemeEditorStore.getState();
  if (store.session) {
    store.closeThemeEditor();
    return;
  }

  const baseThemeId = getThemeDefinition(input.theme)?.id ?? null;
  const activeThemeId = input.themeHalves?.[input.initialAppearance] ?? baseThemeId;
  const seedThemeId = activeThemeId ? (getThemeDefinition(activeThemeId)?.id ?? null) : null;
  store.openThemeEditor({
    editingThemeId: null,
    seedThemeId,
    seedName: null,
    initialAppearance: input.initialAppearance,
  });
}
