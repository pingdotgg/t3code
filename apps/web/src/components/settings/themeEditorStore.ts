import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import {
  getThemeDefinition,
  type ThemeAppearance,
  type PublishedThemeDefinition,
  type ThemeHalves,
  type ThemePreference,
} from "../../themePalette";

export type ThemeEditorSessionInput = {
  editingThemeId: string | null;
  seedThemeId: string | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
  published?: {
    environmentId: EnvironmentId;
    theme: PublishedThemeDefinition;
  };
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  id: number;
  isSaving: boolean;
};

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  setThemeEditorSaving: (sessionId: number, isSaving: boolean) => void;
  closeThemeEditor: (sessionId: number) => void;
};

let nextSessionId = 0;

export const useThemeEditorStore = create<ThemeEditorStore>((set) => ({
  session: null,
  openThemeEditor: (session) =>
    set((store) =>
      store.session?.isSaving
        ? store
        : { session: { ...session, id: ++nextSessionId, isSaving: false } },
    ),
  setThemeEditorSaving: (sessionId, isSaving) =>
    set((store) =>
      store.session?.id === sessionId ? { session: { ...store.session, isSaving } } : store,
    ),
  closeThemeEditor: (sessionId) =>
    set((store) =>
      store.session?.id === sessionId && !store.session.isSaving ? { session: null } : store,
    ),
}));

export function toggleThemeEditorForTheme(input: {
  theme: ThemePreference;
  themeHalves: ThemeHalves | null;
  initialAppearance: ThemeAppearance;
}): void {
  const store = useThemeEditorStore.getState();
  if (store.session) {
    store.closeThemeEditor(store.session.id);
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
