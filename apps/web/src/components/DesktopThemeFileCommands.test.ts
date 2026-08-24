import { assert } from "@effect/vitest";
import { afterEach, beforeEach, describe, it, vi } from "vite-plus/test";

import { getCustomThemes, invalidateCustomThemes } from "../themePalette";
import { importDesktopThemeFile } from "./DesktopThemeFileCommands";

const vscodeTheme = (background: string) => ({
  name: "Omarchy Current",
  type: "dark",
  colors: {
    "editor.background": background,
    "editor.foreground": "#cacccc",
  },
});

describe("DesktopThemeFileCommands", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        clear: () => stored.clear(),
        getItem: (key: string) => stored.get(key) ?? null,
        removeItem: (key: string) => stored.delete(key),
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    invalidateCustomThemes();
  });

  afterEach(() => {
    invalidateCustomThemes();
    vi.unstubAllGlobals();
  });

  it("installs and updates a requested VS Code theme", () => {
    const firstId = importDesktopThemeFile({
      name: "vscode.json",
      size: 100,
      text: JSON.stringify(vscodeTheme("#101315")),
    });

    assert.equal(getCustomThemes().length, 1);
    assert.equal(getCustomThemes()[0]?.id, firstId);
    const firstCanvas = getCustomThemes()[0]?.colors.canvas;

    const secondId = importDesktopThemeFile({
      name: "vscode.json",
      size: 100,
      text: JSON.stringify(vscodeTheme("#202426")),
    });

    assert.equal(secondId, firstId);
    assert.equal(getCustomThemes().length, 1);
    assert.notEqual(getCustomThemes()[0]?.colors.canvas, firstCanvas);
  });
});
