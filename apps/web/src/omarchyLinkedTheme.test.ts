import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getAvailableOmarchyLinkedTheme,
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  OMARCHY_LINKED_THEME_ID,
  parseThemeFile,
  setOmarchyLinkedTheme,
  THEME_FILE_VERSION,
} from "./themePalette";
import { syncOmarchyLinkedTheme } from "./omarchyLinkedTheme";

const VSCODE_THEME = JSON.stringify({
  name: "Omarchy",
  type: "dark",
  colors: {
    "editor.background": "#111111",
    "editor.foreground": "#eeeeee",
    focusBorder: "#7aa2f7",
  },
});

afterEach(() => {
  setOmarchyLinkedTheme(null);
  vi.unstubAllGlobals();
  invalidateCustomThemes();
});

describe("Omarchy linked theme", () => {
  it("installs a stable linked identity, preserves it on invalid updates, and removes it on absence", () => {
    const installed = syncOmarchyLinkedTheme({
      name: "vscode-theme.json",
      size: VSCODE_THEME.length,
      text: VSCODE_THEME,
    });
    expect(installed.status).toBe("updated");
    expect(getAvailableOmarchyLinkedTheme()).toMatchObject({
      id: OMARCHY_LINKED_THEME_ID,
      label: "Omarchy Linked",
      appearance: "dark",
    });
    expect(getThemeDefinition(OMARCHY_LINKED_THEME_ID)?.colors.canvas).toBeDefined();

    const invalid = syncOmarchyLinkedTheme({
      name: "vscode-theme.json",
      size: 1,
      text: "{",
    });
    expect(invalid.status).toBe("preserved");
    expect(getAvailableOmarchyLinkedTheme()?.id).toBe(OMARCHY_LINKED_THEME_ID);

    expect(syncOmarchyLinkedTheme(null)).toEqual({ status: "removed" });
    expect(getAvailableOmarchyLinkedTheme()).toBeNull();
    expect(getThemeDefinition(OMARCHY_LINKED_THEME_ID)).toBeNull();
  });

  it("does not reserve or replace an existing custom theme named Omarchy Linked", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    invalidateCustomThemes();
    const customTheme = installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Omarchy Linked",
        appearance: "light",
        colors: { canvas: "#ffffff" },
      }),
    );

    expect(customTheme.id).toBe("omarchy-linked");
    expect(OMARCHY_LINKED_THEME_ID).toBe("__omarchy-linked");
    expect(getThemeDefinition("omarchy-linked")).toEqual(customTheme);

    syncOmarchyLinkedTheme({
      name: "vscode-theme.json",
      size: VSCODE_THEME.length,
      text: VSCODE_THEME,
    });
    expect(getThemeDefinition("omarchy-linked")).toEqual(customTheme);
    expect(getThemeDefinition(OMARCHY_LINKED_THEME_ID)?.label).toBe("Omarchy Linked");
  });
});
