import { describe, expect, it, vi } from "vite-plus/test";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import {
  applyThemeColorPreview,
  applyThemePalette,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  getThemePreviewSidebarArtwork,
  getThemePreferenceMode,
  isKnownThemePreference,
  getCustomThemes,
  getStoredCustomThemeCollection,
  invalidateCustomThemes,
  installCustomTheme,
  canonicalThemePreference,
  parseThemeFile,
  parseThemeHalves,
  removeCustomTheme,
  removeCustomThemes,
  replaceCustomThemeCollection,
  resolveDesktopTheme,
  resolveThemeAppearance,
  serializeThemeFile,
  subscribeToThemePreview,
  subscribeToCustomThemes,
  themeAllowsSidebarArtwork,
  T3_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  updateCustomTheme,
  CUSTOM_THEMES_STORAGE_KEY,
  createManagedThemeColors,
  createVividThemeColors,
  deriveThemeSemanticColors,
  getDefaultThemeColors,
  themeColorToHex,
  toCanonicalThemeColor,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
} from "./themePalette";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex.slice(0, 7);
}

function canonical(value: string): string {
  const color = toCanonicalThemeColor(value);
  if (!color) throw new Error(`Expected a theme color, received ${value}`);
  return color;
}

function expectThemeColors(
  colors: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): void {
  for (const [role, value] of Object.entries(expected)) {
    expect(asHex(colors[role]!)).toBe(value);
  }
}

function contrastRatio(first: string, second: string): number {
  const toRgb = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toRgb(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme files", () => {
  it("keeps every built-in palette value in canonical OKLCH form", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const colors of [theme.colors, ...Object.values(theme.variants ?? {})]) {
        for (const value of Object.values(colors)) {
          expect(toCanonicalThemeColor(value)).toBe(value);
        }
      }
    }
  });

  it("derives a readable palette from extreme simple-editor colors", () => {
    const light = createManagedThemeColors("light", "#111827", "#ffff00");
    const dark = createManagedThemeColors("dark", "#ffffff", "#ffff00");
    const darkDefaults = getDefaultThemeColors("dark");

    expect(asHex(light.canvas)).not.toBe("#111827");
    expect(asHex(dark.canvas)).not.toBe("#ffffff");
    expect(contrastRatio(light.accent, light.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accent, dark.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.mutedForeground, light.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.mutedForeground, dark.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.mutedForeground, light.secondary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.mutedForeground, dark.secondary)).toBeGreaterThanOrEqual(4.5);
    // Status colors fall back to T3 Code's standard red and amber rather than
    // the flagship palette's, so no generated theme inherits a brand tint.
    const channels = (value: string) =>
      [1, 3, 5].map((index) => Number.parseInt(asHex(value).slice(index, index + 2), 16)) as [
        number,
        number,
        number,
      ];
    for (const colors of [light, dark]) {
      const [errorRed, errorGreen, errorBlue] = channels(colors.error);
      // Red leads by a wide margin; the old default was a pink whose blue sat
      // close behind its red.
      expect(errorRed).toBeGreaterThan(errorGreen * 2);
      expect(errorRed).toBeGreaterThan(errorBlue * 2);
      expect(contrastRatio(colors.error, "#ffffff")).toBeGreaterThanOrEqual(2.5);
      const [warnRed, warnGreen, warnBlue] = channels(colors.warning);
      expect(warnRed).toBeGreaterThan(warnBlue);
      expect(warnGreen).toBeGreaterThan(warnBlue);
    }
    expect(asHex(dark.error)).not.toBe(asHex(darkDefaults.error));
  });

  it("derives readable, distinctive vivid palettes from exact seeds", () => {
    const seeds: ReadonlyArray<["light" | "dark", string, string]> = [
      ["light", "#f4f9f2", "#1d8a4e"],
      ["dark", "#101a2c", "#4f8fe8"],
      ["dark", "#211a23", "#df5398"],
      ["light", "#fdf6ec", "#c2571b"],
      // Inverted canvases: the palette follows the picked color, not the slot.
      ["light", "#111827", "#8ab4f8"],
      ["dark", "#f5ecf5", "#a84370"],
    ];
    for (const [appearance, canvas, accent] of seeds) {
      const colors = createVividThemeColors(appearance, canvas, accent);
      // Exact seeds are honored.
      expect(colors.canvas).toMatch(/^oklch\(/);
      expect(colors.accent).toMatch(/^oklch\(/);
      expect(asHex(colors.canvas)).toBe(canvas);
      expect(asHex(colors.accent)).toBe(accent);
      // Source text colors are solved against the generated canvas family.
      expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.mutedForeground, colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.mutedForeground, colors.secondary)).toBeGreaterThanOrEqual(4.5);
      // The companion action is a distinct voice, not the accent again.
      expect(colors.messageAction).not.toBe(colors.accent);
      expect(Object.keys(colors)).toEqual(THEME_COLOR_ROLES);
    }
  });

  it("merges a small user file onto the matching contrast-safe base palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Ocean dusk",
      appearance: "dark",
      colors: {
        canvas: "#07152f",
        accent: "#67c2ff",
      },
    });

    expect(theme).toMatchObject({
      id: "ocean-dusk",
      label: "Ocean dusk",
      appearance: "dark",
      colors: {
        canvas: canonical("#07152f"),
        accent: canonical("#67c2ff"),
        mutedForeground: canonical("#e7d0dd"),
      },
    });
  });

  it("decodes literal CSS color formats into OKLCH without dropping alpha", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Translucent",
      appearance: "light",
      colors: {
        canvas: "oklch(62% 0.2 280deg / 50%)",
        accent: "#abcd",
        error: "hsl(350 80% 50%)",
        warning: "hwb(45 10% 20%)",
        messageAction: "lch(60% 50 120)",
        sidebar: "oklab(0.6 0.1 -0.1)",
        codeBackground: "color(display-p3 0.8 0.2 0.3)",
        terminalBackground: "transparent",
      },
    });

    expect(theme.colors.canvas).toBe("oklch(0.62 0.2 280 / 0.5)");
    expect(theme.colors.accent).toBe(canonical("#abcd"));
    expect(themeColorToHex(theme.colors.accent)).toBe("#aabbccdd");
    expect(theme.colors.terminalBackground).toBe("oklch(0 0 0 / 0)");
    for (const role of [
      "error",
      "warning",
      "messageAction",
      "sidebar",
      "codeBackground",
    ] as const) {
      expect(theme.colors[role]).toMatch(/^oklch\(/);
    }
  });

  it("imports legacy v1 roles but exports only the 20 current roles", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Legacy",
      appearance: "dark",
      colors: {
        canvas: "#101010",
        accent: "#4488ff",
        chrome: "#202020",
        terminalCursor: "#ffffff",
      },
    });
    const exported = JSON.parse(serializeThemeFile(theme)) as { colors: Record<string, string> };

    expect(Object.keys(exported.colors)).toEqual(THEME_COLOR_ROLES);
    expect(exported.colors).not.toHaveProperty("chrome");
    expect(exported.colors).not.toHaveProperty("terminalCursor");

    const legacyOnly = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Legacy chrome",
      appearance: "light",
      colors: { chrome: "#ffffff" },
    });
    expect(Object.keys(legacyOnly.colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
  });

  it("gamut maps extreme finite OKLCH chroma from theme files", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Extreme chroma",
      appearance: "light",
      colors: { accent: "oklch(0.5 1e303 0)" },
    });

    expect(theme.colors.accent).toBe("oklch(0.5 1e+303 0)");
    expect(themeColorToHex(theme.colors.accent)).toBe("#b5005e");
  });

  it("rejects unknown roles and invalid color values", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { background: "#ffffff" },
      }),
    ).toThrow('"background" is not a supported theme color role.');

    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { accent: "var(--danger)" },
      }),
    ).toThrow('The color for "accent" must be a literal CSS color');
  });

  it("canonicalizes the explicitly exported theme", () => {
    const serialized = serializeThemeFile({
      ...T3_CHAT_THEME,
      colors: { ...T3_CHAT_THEME.colors, accent: "hsl(263 70% 58%)" },
    });
    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: T3_CHAT_THEME.id,
      name: T3_CHAT_THEME.label,
      appearance: "light",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
  });

  it("serializes a theme back into the importable file shape", () => {
    const theme = {
      ...parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "community-demo",
        name: "Community Demo",
        appearance: "dark",
        colors: { canvas: "#111111" },
      }),
      collection: { id: "open-vsx:demo.theme", label: "Demo Theme" },
    };
    const serialized = serializeThemeFile(theme);
    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: theme.id,
      name: theme.label,
      appearance: "dark",
      collection: theme.collection,
    });
    expect(parseThemeFile(JSON.parse(serialized)).collection).toEqual(theme.collection);
  });

  it("keeps sidebar artwork disabled for custom theme files", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Art sidebar",
      appearance: "light",
      colors: { accent: "#5b6cff" },
      sidebarArtwork: true,
    });

    expect(theme.sidebarArtwork).toBeUndefined();
    expect(JSON.parse(serializeThemeFile(theme))).not.toHaveProperty("sidebarArtwork");
  });

  it("suppresses sidebar artwork during a live custom-theme preview", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToThemePreview(listener);
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
        dataset: {},
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      },
    });

    applyThemeColorPreview(T3_CHAT_THEME.colors, "light");
    expect(getThemePreviewSidebarArtwork()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    applyThemePalette("system");
    expect(getThemePreviewSidebarArtwork()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    vi.unstubAllGlobals();
  });

  it("keeps optional light and dark palettes under one theme id", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance: "light",
      colors: { canvas: "#f8fbff", text: "#10243d" },
      variants: {
        dark: { canvas: "#101827", text: "#eef5ff" },
      },
    });

    expect(getThemeModes(theme)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
    expect(getThemeModes(T3_CHAT_THEME)).toEqual(["light", "dark"]);
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, true, true)).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, true)).toBe("system");
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, false, false, "dark")).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, false, "dark")).toBe("dark");
    expect(JSON.parse(serializeThemeFile(theme)).variants.dark).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
  });

  it("keeps the T3 Chat palette faithful and readable", () => {
    expectThemeColors(T3_CHAT_THEME.colors, {
      canvas: "#fdf7fd",
      surfaceRaised: "#fdfafd",
      input: "#e7c1dc",
      accent: "#db2777",
      messageSurface: "#f7def2",
      codeBackground: "#f5ecf9",
      accentSurface: "#f3e6f5",
      sidebar: "#f2e1f4",
    });
    expectThemeColors(T3_CHAT_THEME.variants!.dark!, {
      canvas: "#1f1a24",
      surface: "#29232d",
      surfaceRaised: "#2c2631",
      input: "#302029",
      accent: "#a3004c",
      messageSurface: "#2b2431",
      codeBackground: "#1f1a24",
      sidebar: "#171018",
    });

    for (const mode of ["light", "dark"] as const) {
      const colors = getThemeColorsForMode(T3_CHAT_THEME, mode)!;
      expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.mutedForeground, colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(Object.keys(colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
    }
  });

  it("includes the dual-mode maintainer themes", () => {
    for (const theme of [T3_CHAT_THEME, GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME]) {
      expect(getThemeDefinition(theme.id)).toBe(theme);
      expect(getThemeModes(theme)).toEqual(["light", "dark"]);
      expect(theme.sidebarArtwork).toBe(true);
      expect(themeAllowsSidebarArtwork(theme.id)).toBe(true);
      expect(theme.colors.accent).toMatch(/^oklch\(/);
      expect(theme.variants?.dark?.accent).toMatch(/^oklch\(/);

      for (const mode of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();
        expect(contrastRatio(colors!.text, colors!.canvas)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.mutedForeground, colors!.canvas)).toBeGreaterThanOrEqual(4.5);
        expect(Object.keys(colors!).sort()).toEqual([...THEME_COLOR_ROLES].sort());
      }
    }
    expect(themeAllowsSidebarArtwork("my-custom-theme")).toBe(false);
  });

  it("rejects a variant that repeats the base appearance", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Duplicate light",
        appearance: "light",
        colors: { canvas: "#f8fbff" },
        variants: { light: { canvas: "#101827" } },
      }),
    ).toThrow('Theme variants must not repeat the base appearance "light".');
  });

  it("keeps a single-mode theme on its only palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "midnight-slate",
      name: "Midnight Slate",
      appearance: "dark",
      colors: { canvas: "#111827", messageAction: "#2563eb" },
    });

    expect(getThemeModes(theme)).toEqual(["dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: canonical("#111827"),
    });
    expect(getThemeColorsForMode(theme, "light")).toBeNull();
  });

  it("invalidates cached themes when another tab clears localStorage", () => {
    let storedThemes: string | null = JSON.stringify([
      {
        id: "ocean-dusk",
        label: "Ocean dusk",
        appearance: "dark",
        colors: { canvas: "#07152f" },
      },
    ]);
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      removeEventListener: vi.fn(),
      localStorage: {
        getItem: (key: string) => (key === CUSTOM_THEMES_STORAGE_KEY ? storedThemes : null),
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toHaveLength(1);
    const listener = vi.fn();
    const unsubscribe = subscribeToCustomThemes(listener);

    storedThemes = null;
    storageHandler?.({ key: null } as StorageEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCustomThemes()).toEqual([]);
    unsubscribe();
    invalidateCustomThemes();
    vi.unstubAllGlobals();
  });

  it("preserves valid imported-theme collections and drops malformed metadata", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY
            ? JSON.stringify([
                {
                  id: "github-dark",
                  label: "GitHub Dark",
                  appearance: "dark",
                  colors: { canvas: "#0d1117" },
                  collection: { id: "open-vsx:github.github-vscode-theme", label: "GitHub Theme" },
                },
                {
                  id: "github-light",
                  label: "GitHub Light",
                  appearance: "light",
                  colors: { canvas: "#ffffff" },
                  collection: { id: "bad collection id", label: "GitHub Theme" },
                },
              ])
            : null,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toMatchObject([
      { collection: { id: "open-vsx:github.github-vscode-theme", label: "GitHub Theme" } },
      { id: "github-light" },
    ]);
    expect(getCustomThemes()[1]).not.toHaveProperty("collection");

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("atomically replaces an imported collection and removes stale variants", () => {
    const collection = { id: "open-vsx:demo.theme", label: "Demo Theme" };
    const personalTheme = {
      id: "personal",
      label: "Personal",
      appearance: "dark",
      colors: { canvas: "#111111", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    const stored = new Map<string, string>([
      [
        CUSTOM_THEMES_STORAGE_KEY,
        JSON.stringify([
          personalTheme,
          {
            id: "old-light",
            label: "Old Light",
            appearance: "light",
            colors: { canvas: "#ffffff" },
            collection,
          },
          {
            id: "removed-dark",
            label: "Removed Dark",
            appearance: "dark",
            colors: { canvas: "#000000" },
            collection,
          },
        ]),
      ],
    ]);
    const setItem = vi.fn((key: string, value: string) => stored.set(key, value));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem,
      },
    });

    invalidateCustomThemes();
    const expectedCollection = getStoredCustomThemeCollection(collection.id);
    getCustomThemes();
    const concurrentlyAddedTheme = {
      id: "other-tab",
      label: "Other Tab",
      appearance: "dark",
      colors: { canvas: "#222222" },
    };
    stored.set(
      CUSTOM_THEMES_STORAGE_KEY,
      JSON.stringify([
        ...JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]"),
        concurrentlyAddedTheme,
      ]),
    );
    const replacement = [
      {
        ...parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "old-light",
          name: "New Light",
          appearance: "light",
          colors: { canvas: "#fafafa" },
        }),
        collection,
      },
      {
        ...parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "new-dark",
          name: "New Dark",
          appearance: "dark",
          colors: { canvas: "#101010" },
        }),
        collection,
      },
    ];

    expect(
      replaceCustomThemeCollection(collection.id, replacement, { expectedCollection }),
    ).toEqual(replacement);
    expect(getCustomThemes().map((theme) => theme.id)).toEqual([
      "personal",
      "old-light",
      "new-dark",
      "other-tab",
    ]);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")[0]).toEqual(personalTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("replaces collection entries even when their stored collection label is malformed", () => {
    const collection = { id: "open-vsx:demo.theme", label: "Demo Theme" };
    const stored = new Map<string, string>([
      [
        CUSTOM_THEMES_STORAGE_KEY,
        JSON.stringify([
          {
            id: "old-light",
            label: "Old Light",
            appearance: "light",
            colors: { canvas: "#ffffff" },
            collection: { id: collection.id, label: 42 },
          },
        ]),
      ],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });

    invalidateCustomThemes();
    const replacement = {
      ...parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "old-light",
        name: "New Light",
        appearance: "light",
        colors: { canvas: "#fafafa" },
      }),
      collection,
    };

    expect(replaceCustomThemeCollection(collection.id, [replacement])).toEqual([replacement]);
    expect(getCustomThemes()).toEqual([replacement]);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("canonicalizes explicit writes without migrating untouched themes", () => {
    const stored = new Map<string, string>();
    const untouchedTheme = {
      id: "legacy",
      label: "Legacy",
      appearance: "dark",
      colors: { accent: "#5b6cff", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    stored.set(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([untouchedTheme]));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });

    invalidateCustomThemes();
    const createdTheme = installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff", accent: "#5b6cff" },
        sidebarArtwork: true,
      }),
    );
    const updatedTheme = updateCustomTheme({
      ...createdTheme,
      label: "Aurora Night",
      colors: { ...createdTheme.colors, accent: "hsl(263 70% 58%)" },
    });

    expect(updatedTheme).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    expect(updatedTheme).not.toHaveProperty("sidebarArtwork");
    const storedThemes = JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]");
    expect(storedThemes[0]).toEqual(untouchedTheme);
    expect(storedThemes[1]).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    expect(storedThemes[1]).not.toHaveProperty("sidebarArtwork");
    invalidateCustomThemes();
    expect(getCustomThemes().find((theme) => theme.id === "aurora")).toMatchObject({
      id: "aurora",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    removeCustomTheme("aurora");
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")).toEqual([untouchedTheme]);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("removes multiple custom themes atomically while preserving unrelated entries", () => {
    const collection = { id: "open-vsx:demo.theme", label: "Demo Theme" };
    const personalTheme = {
      id: "personal",
      label: "Personal",
      appearance: "dark",
      colors: { canvas: "#111111", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    const stored = new Map<string, string>([
      [
        CUSTOM_THEMES_STORAGE_KEY,
        JSON.stringify([
          personalTheme,
          {
            id: "demo-light",
            label: "Demo Light",
            appearance: "light",
            colors: { canvas: "#ffffff" },
            collection,
          },
          {
            id: "demo-dark",
            label: "Demo Dark",
            appearance: "dark",
            colors: { canvas: "#000000" },
            collection,
          },
        ]),
      ],
    ]);
    const setItem = vi.fn((key: string, value: string) => stored.set(key, value));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem,
      },
    });

    invalidateCustomThemes();
    removeCustomThemes(["demo-light", "demo-dark"]);

    expect(setItem).toHaveBeenCalledOnce();
    expect(getCustomThemes()).toEqual([expect.objectContaining({ id: "personal" })]);
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")).toEqual([personalTheme]);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("writes from the cached raw snapshot without risking a destructive reread", () => {
    const legacyTheme = {
      id: "legacy",
      label: "Legacy",
      appearance: "dark",
      colors: { accent: "#5b6cff" },
      futureMetadata: true,
    };
    let storedThemes = JSON.stringify([legacyTheme]);
    let readCount = 0;
    const setItem = vi.fn((_key: string, value: string) => {
      storedThemes = value;
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          readCount += 1;
          if (readCount > 1) throw new Error("transient read failure");
          return storedThemes;
        },
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toHaveLength(1);
    installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "light",
        colors: { accent: "hsl(263 70% 58%)" },
      }),
    );

    expect(readCount).toBe(1);
    expect(setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(storedThemes)[0]).toEqual(legacyTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("refuses to overwrite a theme library that could not be read", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("storage unavailable");
        },
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toEqual([]);
    expect(() =>
      installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "aurora",
          name: "Aurora",
          appearance: "light",
          colors: { accent: "#5b6cff" },
        }),
      ),
    ).toThrow(`Failed to read the theme library from ${CUSTOM_THEMES_STORAGE_KEY}.`);
    expect(setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("rejects malformed stored entries that reuse an installed theme id", () => {
    const storedThemes = JSON.stringify([{ id: "aurora", malformed: true }]);
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => storedThemes,
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(() =>
      installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "aurora",
          name: "Aurora",
          appearance: "light",
          colors: { accent: "#5b6cff" },
        }),
      ),
    ).toThrow('A theme named "Aurora" is already installed.');
    expect(setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("collapses duplicate raw entries when their theme is explicitly updated", () => {
    const stored = new Map<string, string>();
    const theme = {
      id: "aurora",
      label: "Aurora",
      appearance: "light",
      colors: { accent: "#5b6cff" },
    };
    const untouchedTheme = { id: "future", malformed: true, metadata: { version: 2 } };
    stored.set(
      CUSTOM_THEMES_STORAGE_KEY,
      JSON.stringify([theme, { id: "aurora", malformed: true }, untouchedTheme]),
    );
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });

    invalidateCustomThemes();
    const installedTheme = getCustomThemes()[0]!;
    updateCustomTheme({
      ...installedTheme,
      label: "Aurora Night",
      colors: { ...installedTheme.colors, accent: "hsl(263 70% 58%)" },
    });

    const updatedLibrary = JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]");
    expect(updatedLibrary.filter((entry: { id?: string }) => entry.id === "aurora")).toHaveLength(
      1,
    );
    expect(updatedLibrary[0]).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    expect(updatedLibrary[1]).toEqual(untouchedTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});

describe("derived theme semantics", () => {
  it("keeps every independently editable surface and status pair readable", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const colors of [theme.colors, ...Object.values(theme.variants ?? {})]) {
        const semantic = deriveThemeSemanticColors(colors);
        const readablePairs = [
          [semantic.cardForeground, colors.surface],
          [semantic.popoverForeground, colors.surfaceOverlay],
          [semantic.primaryForeground, colors.messageAction],
          [semantic.primaryForeground, semantic.messageActionHover],
          [semantic.secondaryForeground, colors.secondary],
          [semantic.placeholder, colors.surfaceRaised],
          [semantic.accentForeground, colors.accentSurface],
          [semantic.errorForeground, semantic.errorSurface],
          [semantic.errorForeground, colors.surface],
          [semantic.warningForeground, semantic.warningSurface],
          [semantic.warningForeground, colors.surface],
          [semantic.updateForeground, semantic.updateSurface],
          [semantic.updateForeground, colors.surface],
          [semantic.messageForeground, colors.messageSurface],
          [semantic.codeForeground, colors.codeBackground],
          [semantic.sidebarForeground, colors.sidebar],
          [semantic.sidebarMutedForeground, colors.sidebar],
          [semantic.terminalForeground, colors.terminalBackground],
        ] as const;

        for (const [foreground, background] of readablePairs) {
          expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("adapts text when an imported theme inverts independent surfaces", () => {
    const colors = {
      ...getDefaultThemeColors("dark"),
      text: canonical("#f5f5f5"),
      sidebar: canonical("#fafafa"),
      terminalBackground: canonical("#fbfbfb"),
    };
    const semantic = deriveThemeSemanticColors(colors);

    expect(contrastRatio(semantic.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(semantic.sidebarMutedForeground, colors.sidebar)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrastRatio(semantic.terminalForeground, colors.terminalBackground),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("measures translucent foregrounds after compositing them onto their surface", () => {
    const colors = {
      ...getDefaultThemeColors("light"),
      canvas: canonical("#ffffff"),
      surface: canonical("#ffffff"),
      text: canonical("rgb(0 0 0 / 10%)"),
    };
    const semantic = deriveThemeSemanticColors(colors);

    expect(semantic.cardForeground).not.toBe(colors.text);
    expect(themeColorToHex(semantic.cardForeground)).toMatch(/^#[\da-f]{6}$/);
    expect(contrastRatio(semantic.cardForeground, colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("measures translucent surfaces after compositing them onto the canvas", () => {
    const colors = {
      ...getDefaultThemeColors("dark"),
      canvas: canonical("#000000"),
      surface: canonical("rgb(255 255 255 / 10%)"),
      text: canonical("#ffffff"),
    };
    const semantic = deriveThemeSemanticColors(colors);

    expect(contrastRatio(semantic.cardForeground, canonical("#1a1a1a"))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe("stored theme preferences", () => {
  it("lets a configured half unlock an appearance the base theme lacks", () => {
    // Light-only base: without halves, dark requests fall back to light.
    const lightOnly = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "paper",
      name: "Paper",
      appearance: "light",
      colors: { canvas: "#f8fbff" },
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY ? JSON.stringify([lightOnly]) : null,
      },
    });
    invalidateCustomThemes();
    try {
      expect(resolveThemeAppearance("paper", true, true)).toBe("light");
      const halves = { dark: GROVE_THEME.id };
      expect(resolveThemeAppearance("paper", true, true, undefined, halves)).toBe("dark");
      expect(resolveThemeAppearance("paper", false, false, "dark", halves)).toBe("dark");
      expect(resolveDesktopTheme("paper", true, undefined, halves)).toBe("system");
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });

  it("resolves the legacy t3-chat-dark preference to dark T3 Chat", () => {
    expect(getThemeDefinition("t3-chat-dark")).toBe(T3_CHAT_THEME);
    expect(getThemePreferenceMode("t3-chat-dark")).toBe("dark");
    expect(resolveThemeAppearance("t3-chat-dark", true, false)).toBe("dark");
    expect(resolveDesktopTheme("t3-chat-dark", false)).toBe("dark");
    expect(isKnownThemePreference("t3-chat-dark")).toBe(true);
  });

  it("resolves legacy t3-prefixed ids onto the renamed themes", () => {
    for (const [legacy, theme] of [
      ["t3-grove", GROVE_THEME],
      ["t3-ocean", OCEAN_THEME],
      ["t3-ember", EMBER_THEME],
      ["t3-iris", IRIS_THEME],
    ] as const) {
      expect(getThemeDefinition(legacy)).toBe(theme);
      expect(isKnownThemePreference(legacy)).toBe(true);
      expect(canonicalThemePreference(legacy)).toBe(theme.id);
    }
    // The dark-variant alias keeps its raw form: it still carries a mode hint.
    expect(canonicalThemePreference("t3-chat-dark")).toBe("t3-chat-dark");
    // A stored mix that predates the rename resolves to the new ids.
    expect(parseThemeHalves(JSON.stringify({ light: "t3-ocean", dark: "t3-grove" }))).toEqual({
      light: OCEAN_THEME.id,
      dark: GROVE_THEME.id,
    });
  });

  it("recognizes only preferences the runtime can render", () => {
    for (const preference of ["light", "dark", "system", T3_CHAT_THEME.id, GROVE_THEME.id]) {
      expect(isKnownThemePreference(preference)).toBe(true);
    }
    expect(isKnownThemePreference(`${GROVE_THEME.id}:dark`)).toBe(false);
    expect(isKnownThemePreference("missing-theme")).toBe(false);
  });

  it("decodes stored colors in memory without writing during reads", () => {
    const storedThemes = JSON.stringify([
      {
        id: "aurora",
        label: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff", futureRole: "#123456", accent: "not-a-color" },
        variants: { dark: { canvas: "rgb(16 24 39)" } },
      },
      { id: "light", label: "Reserved", appearance: "light", colors: {} },
      { id: "aurora", label: "Duplicate", appearance: "dark", colors: {} },
    ]);
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (key === CUSTOM_THEMES_STORAGE_KEY ? storedThemes : null),
        setItem,
      },
    });
    invalidateCustomThemes();

    const themes = getCustomThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      id: "aurora",
      colors: { canvas: canonical("#f8fbff"), accent: getDefaultThemeColors("light").accent },
    });
    expect(getThemeModes(themes[0]!)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(themes[0]!, "dark")?.canvas).toBe(canonical("rgb(16 24 39)"));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.parse(storedThemes)[0].colors).toEqual({
      canvas: "#f8fbff",
      futureRole: "#123456",
      accent: "not-a-color",
    });

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});
