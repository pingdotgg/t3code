import { afterEach, describe, expect, it } from "vite-plus/test";

import { OCEAN_THEME_ID, T3_CHAT_THEME_ID } from "../../themePalette";
import { toggleThemeEditorForTheme, useThemeEditorStore } from "./themeEditorStore";

afterEach(() => {
  useThemeEditorStore.getState().closeThemeEditor();
});

describe("toggleThemeEditorForTheme", () => {
  it("opens a new editor seeded from the theme active for the current appearance", () => {
    toggleThemeEditorForTheme({
      theme: T3_CHAT_THEME_ID,
      themeHalves: { dark: OCEAN_THEME_ID },
      initialAppearance: "dark",
    });

    expect(useThemeEditorStore.getState().session).toMatchObject({
      editingThemeId: null,
      seedThemeId: OCEAN_THEME_ID,
      seedName: null,
      initialAppearance: "dark",
    });
  });

  it("closes an open editor", () => {
    toggleThemeEditorForTheme({
      theme: T3_CHAT_THEME_ID,
      themeHalves: null,
      initialAppearance: "light",
    });
    toggleThemeEditorForTheme({
      theme: T3_CHAT_THEME_ID,
      themeHalves: null,
      initialAppearance: "light",
    });

    expect(useThemeEditorStore.getState().session).toBeNull();
  });
});
