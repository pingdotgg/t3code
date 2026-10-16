import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentThemeDefinition, publishedThemeDefinitions } from "./useEnvironmentTheme";
import {
  getDefaultThemeColors,
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  setEnvironmentThemes,
  THEME_COLOR_ROLES,
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
  it("generates every role from the two published seeds", () => {
    const theme = environmentThemeDefinition(NIGHTFALL_THEME);

    expect(theme.id).toBe("nightfall");
    expect(theme.label).toBe("Nightfall");
    expect(theme.appearance).toBe("dark");
    for (const role of THEME_COLOR_ROLES) {
      expect(theme.colors[role], `missing ${role}`).toBeTruthy();
    }
  });

  it("layers published roles over the generated palette", () => {
    const generated = environmentThemeDefinition(NIGHTFALL_THEME);
    const overridden = environmentThemeDefinition({
      ...NIGHTFALL_THEME,
      colors: { terminalSelection: "#292e42", error: "#f7768e" },
    });

    expect(overridden.colors.terminalSelection).not.toBe(generated.colors.terminalSelection);
    expect(overridden.colors.error).not.toBe(generated.colors.error);
    expect(overridden.colors.sidebar).toBe(generated.colors.sidebar);
  });

  it("renders an exported theme file on the stock defaults", () => {
    const theme = environmentThemeDefinition({
      id: "shared-light",
      version: 1,
      name: "Shared Light",
      appearance: "light",
      colors: { canvas: "oklch(0.95 0.01 250)", accent: "#1e66f5" },
      variants: { dark: { canvas: "#1a1b26" } },
    });

    expect(theme.label).toBe("Shared Light");
    expect(theme.colors.accent).toBeTruthy();
    expect(theme.variants?.dark?.canvas).toBeTruthy();
    for (const role of THEME_COLOR_ROLES) {
      expect(theme.colors[role], `missing ${role}`).toBeTruthy();
      expect(theme.variants?.dark?.[role], `missing dark ${role}`).toBeTruthy();
    }
  });

  it("builds a seeded theme's variant on the variant appearance's defaults", () => {
    const theme = environmentThemeDefinition({
      ...NIGHTFALL_THEME,
      variants: { light: { canvas: "#eff1f5" } },
    });

    const lightDefaults = getDefaultThemeColors("light");
    expect(theme.variants?.light?.text).toBe(lightDefaults.text);
    expect(theme.variants?.light?.canvas).not.toBe(theme.colors.canvas);
  });

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

  it("ignores published roles this build does not render", () => {
    const theme = environmentThemeDefinition({
      ...NIGHTFALL_THEME,
      colors: { notARole: "#ff0000", text: "#ffffff" },
    });

    expect(theme.colors).not.toHaveProperty("notARole");
    for (const role of THEME_COLOR_ROLES) {
      expect(theme.colors[role], `missing ${role}`).toBeTruthy();
    }
  });

  it("marks only the pure seeded form as managed", () => {
    expect(environmentThemeDefinition(NIGHTFALL_THEME).managed).toBe(true);
    expect(
      environmentThemeDefinition({ ...NIGHTFALL_THEME, colors: { error: "#f7768e" } }).managed,
    ).toBeUndefined();
    expect(
      environmentThemeDefinition({
        id: "shared-light",
        version: 1,
        name: "Shared Light",
        appearance: "light",
        colors: { canvas: "#eff1f5", accent: "#1e66f5" },
      }).managed,
    ).toBeUndefined();
  });

  it("resolves published ids only while the machine publishes them", () => {
    expect(getThemeDefinition("nightfall")).toBe(null);

    setEnvironmentThemes([environmentThemeDefinition(NIGHTFALL_THEME)]);
    expect(getThemeDefinition("nightfall")?.label).toBe("Nightfall");

    setEnvironmentThemes([]);
    expect(getThemeDefinition("nightfall")).toBe(null);
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
