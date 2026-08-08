import { describe, expect, it, vi } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getDefaultThemeColors,
  getThemeColorsForMode,
  invalidateCustomThemes,
  isKnownThemePreference,
  resolveThemeAppearance,
  T3_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
} from "./themePalette";

const THEME_STORAGE_KEY = "t3code:theme";
// A custom theme that omits chrome falls back to the runtime default, so the
// boot copy of that default stays derived from the real palette.
const DEFAULT_DARK_CHROME = getDefaultThemeColors("dark").chrome;

const bootScript = (() => {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the inline boot script in index.html");
  return match[1];
})();

type BootResult = {
  isDark: boolean;
  themeId: string | undefined;
  themeSelected: string | undefined;
  backgroundColor: string;
  bootVariables: Record<string, string>;
  metaContent: string | null;
};

function runBootScript(options: {
  storage?: Record<string, string>;
  storageThrows?: boolean;
  prefersDark: boolean;
}): BootResult {
  const classes = new Set<string>();
  const bootVariables: Record<string, string> = {};
  const meta = {
    content: null as string | null,
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };
  const documentElement = {
    dataset: {} as Record<string, string | undefined>,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    style: {
      backgroundColor: "",
      setProperty: (name: string, value: string) => {
        bootVariables[name] = value;
      },
    },
  };
  const fakeDocument = {
    documentElement,
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? [meta] : []),
  };
  const fakeWindow = {
    localStorage: {
      getItem: (key: string): string | null => {
        if (options.storageThrows) throw new Error("storage blocked");
        return options.storage?.[key] ?? null;
      },
    },
    matchMedia: () => ({ matches: options.prefersDark }),
  };

  new Function("window", "document", bootScript)(fakeWindow, fakeDocument);

  return {
    isDark: classes.has("dark"),
    themeId: documentElement.dataset.themeId,
    themeSelected: documentElement.dataset.themeSelected,
    backgroundColor: documentElement.style.backgroundColor,
    bootVariables,
    metaContent: meta.content,
  };
}

/** Mirrors getStored + readAppearanceModePreference + resolveThemeAppearance from the runtime. */
function runtimeResolvedAppearance(
  storage: Record<string, string>,
  prefersDark: boolean,
): "light" | "dark" {
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    matchMedia: () => ({ matches: prefersDark }),
  });
  invalidateCustomThemes();
  try {
    const raw = storage[THEME_STORAGE_KEY] ?? null;
    const theme = raw !== null && isKnownThemePreference(raw) ? raw : "system";
    const followRaw = storage[THEME_FOLLOW_SYSTEM_STORAGE_KEY] ?? null;
    const appearanceRaw = storage[THEME_APPEARANCE_MODE_STORAGE_KEY] ?? null;
    const appearanceMode =
      appearanceRaw === "light" || appearanceRaw === "dark" || appearanceRaw === "system"
        ? appearanceRaw
        : followRaw === "true"
          ? "system"
          : followRaw === "false"
            ? null
            : theme === "system"
              ? "system"
              : null;
    const followSystem = appearanceMode === "system";
    return resolveThemeAppearance(theme, prefersDark, followSystem, appearanceMode ?? undefined);
  } finally {
    vi.unstubAllGlobals();
    invalidateCustomThemes();
  }
}

const AURORA_DUAL = {
  id: "aurora",
  label: "Aurora",
  appearance: "light",
  colors: { canvas: "#f8fbff", text: "#10243d", accent: "#5b6cff" },
  variants: { dark: { canvas: "#101827", text: "#eef5ff", accent: "#7c93ff" } },
};
const CHARCOAL_DARK_ONLY = {
  id: "charcoal",
  label: "Charcoal",
  appearance: "dark",
  colors: { canvas: "#1c1210", text: "#ffe8d9", accent: "#ff7a45" },
};

describe("index.html boot script", () => {
  const parityCases: ReadonlyArray<{
    name: string;
    storage: Record<string, string>;
    prefersDark: boolean;
  }> = [
    { name: "no stored preference on a dark OS", storage: {}, prefersDark: true },
    {
      name: "T3 Chat follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "t3-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "an explicit global dark mode applies to T3 Chat",
      storage: {
        [THEME_STORAGE_KEY]: "t3-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false",
      },
      prefersDark: false,
    },
    {
      name: "Grove follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Ocean follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "ocean", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Ember follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "ember", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "Iris follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "iris", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "a legacy t3-grove preference resolves through the alias",
      storage: { [THEME_STORAGE_KEY]: "t3-grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "legacy t3-chat-dark resolves to dark T3 Chat",
      storage: { [THEME_STORAGE_KEY]: "t3-chat-dark" },
      prefersDark: true,
    },
    {
      name: "a dual-mode custom theme follows the OS",
      storage: {
        [THEME_STORAGE_KEY]: "aurora",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    },
    {
      name: "a dark-only custom theme stays dark on a light OS",
      storage: {
        [THEME_STORAGE_KEY]: "charcoal",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([CHARCOAL_DARK_ONLY]),
      },
      prefersDark: false,
    },
    {
      name: "a legacy mode-suffixed preference is treated as unknown",
      storage: {
        [THEME_STORAGE_KEY]: "aurora:dark",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    },
    {
      name: "a removed custom theme falls back to system",
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    },
    {
      name: "a corrupted follow-system value falls back to inference",
      storage: { [THEME_STORAGE_KEY]: "system", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "1" },
      prefersDark: true,
    },
    {
      name: "follow-system off keeps an explicit light preference on a dark OS",
      storage: { [THEME_STORAGE_KEY]: "light", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: true,
    },
    {
      name: "a bare dark preference stays dark on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark" },
      prefersDark: false,
    },
    {
      name: "follow-system off keeps a bare dark preference on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: false,
    },
  ];

  it.each(parityCases)("matches the runtime appearance: $name", ({ storage, prefersDark }) => {
    const boot = runBootScript({ storage, prefersDark });
    expect(boot.isDark).toBe(runtimeResolvedAppearance(storage, prefersDark) === "dark");
  });

  it("marks built-in and custom themes on the document element", () => {
    const chat = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "t3-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    });
    expect(chat.themeId).toBe("t3-chat");
    expect(chat.themeSelected).toBe("true");
    expect(chat.isDark).toBe(true);

    const aurora = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "aurora",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([AURORA_DUAL]),
      },
      prefersDark: true,
    });
    expect(aurora.themeId).toBe("aurora");
    expect(aurora.isDark).toBe(true);
    expect(aurora.backgroundColor).toBe(DEFAULT_DARK_CHROME);
    expect(aurora.bootVariables["--boot-background"]).toBe(AURORA_DUAL.variants.dark.canvas);
    expect(aurora.metaContent).toBe(DEFAULT_DARK_CHROME);
  });

  // Asserting against the real palette definitions (not literals) turns the
  // boot script's hand-maintained copy into a CI-enforced contract: any
  // palette change breaks this test until the copy in index.html is updated.
  it("keeps every built-in boot splash in sync with the real palettes", () => {
    for (const theme of [T3_CHAT_THEME, GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME]) {
      // The boot script resolves every built-in from a light base appearance.
      expect(theme.appearance).toBe("light");
      for (const mode of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();
        const boot = runBootScript({
          storage: {
            [THEME_STORAGE_KEY]: theme.id,
            [THEME_APPEARANCE_MODE_STORAGE_KEY]: mode,
          },
          prefersDark: mode === "dark",
        });
        expect(boot.themeId).toBe(theme.id);
        expect(boot.isDark).toBe(mode === "dark");
        expect(boot.bootVariables["--boot-background"]).toBe(colors!.canvas);
        expect(boot.bootVariables["--boot-foreground"]).toBe(colors!.text);
        expect(boot.bootVariables["--boot-accent"]).toBe(colors!.accent);
        expect(boot.backgroundColor).toBe(colors!.chrome);
        expect(boot.metaContent).toBe(colors!.chrome);
      }
    }
  });

  it("applies the matching half of an automatic mix to the splash", () => {
    const storage = {
      [THEME_STORAGE_KEY]: "t3-chat",
      [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
      "t3code:theme-halves:v1": JSON.stringify({ dark: GROVE_THEME.id }),
    };

    const dark = runBootScript({ storage, prefersDark: true });
    expect(dark.isDark).toBe(true);
    expect(dark.themeId).toBe(GROVE_THEME.id);
    expect(dark.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(GROVE_THEME, "dark")!.canvas,
    );

    const light = runBootScript({ storage, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBe("t3-chat");
    expect(light.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(T3_CHAT_THEME, "light")!.canvas,
    );
  });

  it("lets a dark half go dark when the light-only base cannot", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "paper",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "paper",
            label: "Paper",
            appearance: "light",
            colors: { canvas: "#f8fbff", text: "#10243d", accent: "#5b6cff" },
          },
        ]),
        "t3code:theme-halves:v1": JSON.stringify({ dark: GROVE_THEME.id }),
      },
      prefersDark: true,
    });
    expect(boot.isDark).toBe(true);
    expect(boot.themeId).toBe(GROVE_THEME.id);
  });

  it("paints the half's splash when the base theme no longer exists", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "gone-theme",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        "t3code:theme-halves:v1": JSON.stringify({ dark: GROVE_THEME.id }),
      },
      prefersDark: true,
    });
    expect(boot.isDark).toBe(true);
    expect(boot.themeId).toBe(GROVE_THEME.id);
    expect(boot.themeSelected).toBe("true");
    expect(boot.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(GROVE_THEME, "dark")!.canvas,
    );
  });

  it("resolves a legacy-prefixed mix half onto the renamed theme", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "t3-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        "t3code:theme-halves:v1": JSON.stringify({ dark: "t3-grove" }),
      },
      prefersDark: true,
    });
    expect(boot.isDark).toBe(true);
    expect(boot.themeId).toBe(GROVE_THEME.id);
    expect(boot.bootVariables["--boot-background"]).toBe(
      getThemeColorsForMode(GROVE_THEME, "dark")!.canvas,
    );
  });

  it("ignores a mix half that names an unknown theme", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "t3-chat",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "system",
        "t3code:theme-halves:v1": JSON.stringify({ dark: "gone-theme" }),
      },
      prefersDark: true,
    });
    expect(boot.themeId).toBe("t3-chat");
    expect(boot.isDark).toBe(true);
  });

  it("uses runtime defaults for malformed custom roles", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "partial",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "partial",
            label: "Partial",
            appearance: "dark",
            colors: { canvas: "not-a-color", text: "#fffaff", accent: "nope" },
          },
        ]),
      },
      prefersDark: true,
    });

    expect(boot.themeId).toBe("partial");
    expect(boot.bootVariables["--boot-background"]).toBe("#1f1a24");
    expect(boot.bootVariables["--boot-foreground"]).toBe("#fffaff");
    expect(boot.bootVariables["--boot-accent"]).toBe("#a3004c");
    expect(boot.backgroundColor).toBe(DEFAULT_DARK_CHROME);
    expect(boot.metaContent).toBe(DEFAULT_DARK_CHROME);
  });

  it("ignores malformed custom theme entries before applying a splash", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "broken",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          { id: "broken", label: "Broken", appearance: "light", colors: "bad" },
        ]),
      },
      prefersDark: false,
    });

    expect(boot.themeId).toBeUndefined();
    expect(boot.themeSelected).toBeUndefined();
    expect(boot.backgroundColor).toBe("#ffffff");
    expect(boot.metaContent).toBe("#ffffff");
  });

  it("leaves unknown preferences unthemed so the runtime default applies", () => {
    const boot = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      prefersDark: true,
    });
    expect(boot.themeId).toBeUndefined();
    expect(boot.themeSelected).toBeUndefined();
    expect(boot.isDark).toBe(true);
  });

  it("follows the OS appearance when storage is unavailable", () => {
    const light = runBootScript({ storageThrows: true, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBeUndefined();

    const dark = runBootScript({ storageThrows: true, prefersDark: true });
    expect(dark.isDark).toBe(true);
  });
});
