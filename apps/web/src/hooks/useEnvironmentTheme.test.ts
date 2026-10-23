import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentThemeDefinition, publishedThemeDefinitions } from "./useEnvironmentTheme";
import {
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  setEnvironmentThemes,
} from "../themePalette";

const NIGHTFALL_THEME = {
  id: "nightfall",
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
} as const;

afterEach(() => {
  setEnvironmentThemes([]);
});

describe("environment themes", () => {
  it("drops published themes with reserved ids", () => {
    const definitions = publishedThemeDefinitions([
      NIGHTFALL_THEME,
      { ...NIGHTFALL_THEME, id: "t3-iris", name: "Impostor Iris" },
      { ...NIGHTFALL_THEME, id: "ocean", name: "Impostor Ocean" },
      { ...NIGHTFALL_THEME, id: "dark", name: "Impostor Dark" },
    ]);

    expect(definitions.map((definition) => definition.id)).toEqual(["nightfall"]);
  });

  it("drops published palettes with no usable colors", () => {
    const theme = { id: "invalid", name: "Invalid", appearance: "dark" } as const;
    const definitions = publishedThemeDefinitions([
      { ...theme, colors: { canvas: "not-a-color" } },
      { ...theme, id: "unknown-roles", colors: { futureRole: "#ffffff" } },
      {
        ...theme,
        id: "ignored-variant",
        colors: { canvas: "not-a-color" },
        variants: { dark: { canvas: "#112233" } },
      },
    ]);

    expect(definitions).toEqual([]);
  });

  it("keeps seeds, partial palettes, and usable alternate appearances", () => {
    const theme = { name: "Shared", appearance: "dark" } as const;
    const definitions = publishedThemeDefinitions([
      NIGHTFALL_THEME,
      {
        ...theme,
        id: "partial",
        colors: { canvas: "not-a-color", text: "#ffffff", futureRole: "#ffffff" },
      },
      {
        ...theme,
        id: "light-variant",
        colors: { canvas: "not-a-color" },
        variants: { light: { canvas: "#eff1f5" } },
      },
    ]);

    expect(definitions.map((definition) => definition.id)).toEqual([
      "nightfall",
      "partial",
      "light-variant",
    ]);
  });

  it("lets a theme the user saved win an id collision", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    invalidateCustomThemes();
    try {
      const environment = environmentThemeDefinition(NIGHTFALL_THEME);
      setEnvironmentThemes([environment]);
      installCustomTheme({ ...environment, label: "My Nightfall" });

      expect(getThemeDefinition("nightfall")?.label).toBe("My Nightfall");
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
    expect(getThemeDefinition("nightfall")?.label).toBe("Nightfall");
  });
});
