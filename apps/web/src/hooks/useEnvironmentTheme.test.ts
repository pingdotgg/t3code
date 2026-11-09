import type { EnvironmentTheme } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Like the real config, the themes and the latest event change together in one update.
interface ServerState {
  readonly themes: ReadonlyArray<EnvironmentTheme>;
  readonly event: { readonly type: string } | null;
}
const server = vi.hoisted(() => ({
  state: null as unknown as import("effect/reactivity").Atom.Writable<ServerState>,
}));
vi.mock(import("../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  server.state = Atom.make<ServerState>({ themes: [], event: null });
  return {
    themeServerEnvironmentThemesAtom: Atom.make((get) => get(server.state).themes),
    primaryServerConfigEventAtom: Atom.make((get) => get(server.state).event),
  } as never;
});
const publish = (
  registry: { readonly set: (atom: typeof server.state, state: ServerState) => void },
  themes: ReadonlyArray<EnvironmentTheme>,
) => registry.set(server.state, { themes, event: { type: "environmentThemesUpdated" } });
const refreshTheme = vi.hoisted(() => vi.fn());
vi.mock(import("./useTheme"), () => ({ refreshTheme }) as never);

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  asImportedThemeCopy,
  ENVIRONMENT_THEMES_STORAGE_KEY,
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  publishedThemeDefinitions,
  THEME_FILE_VERSION,
  themeAllowsComposerArtwork,
  themeAllowsSidebarArtwork,
} from "../themePalette";

const NIGHTFALL_THEME = {
  id: "nightfall",
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
} as const;

afterEach(() => {
  appAtomRegistry.set(server.state, { themes: [], event: null });
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

  // Routes without the old root sync component (/connect, prompt-link landings) never saw them.
  it("resolves published themes without a React subscriber mounted", () => {
    publish(appAtomRegistry, [NIGHTFALL_THEME]);
    expect(getThemeDefinition("nightfall")?.label).toBe("Nightfall");
    expect(themeAllowsSidebarArtwork("nightfall")).toBe(false);

    // A published theme, such as a plugin's, can keep the sidebar artwork, but not on the send
    // button, and can set T3's corner radius and status colors.
    publish(appAtomRegistry, [
      {
        ...NIGHTFALL_THEME,
        name: "Nightfall 2",
        sidebarArtwork: true,
        radius: "0.625rem",
        colors: { success: "#3fb950", info: "not-a-color" },
        variants: { light: { info: "#0969da" } },
      },
    ]);
    expect(getThemeDefinition("nightfall")).toMatchObject({
      label: "Nightfall 2",
      radius: "0.625rem",
      statusColors: { dark: { success: "#3fb950" }, light: { info: "#0969da" } },
    });
    expect(themeAllowsSidebarArtwork("nightfall")).toBe(true);
    expect(themeAllowsComposerArtwork("nightfall")).toBe(false);
    // Importing the same theme file makes a copy instead of hiding the published original.
    const imported = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "nightfall",
      name: "Nightfall",
      appearance: "dark",
      colors: { canvas: "#1a1b26" },
    });
    expect(asImportedThemeCopy(imported)).toMatchObject({
      id: "nightfall-copy",
      label: "Nightfall copy",
    });
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
      publish(appAtomRegistry, [NIGHTFALL_THEME]);
      expect(getThemeDefinition("nightfall")?.label).toBe("Nightfall");
      const environment = getThemeDefinition("nightfall");
      if (!environment) throw new Error("expected the published theme");
      installCustomTheme({ ...environment, label: "My Nightfall" });

      expect(getThemeDefinition("nightfall")?.label).toBe("My Nightfall");
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
    expect(getThemeDefinition("nightfall")?.label).toBe("Nightfall");
  });

  it("uses the palettes saved last start until the server sends its own, then saves those", async () => {
    const store = new Map([
      [
        ENVIRONMENT_THEMES_STORAGE_KEY,
        JSON.stringify(
          publishedThemeDefinitions([
            {
              ...NIGHTFALL_THEME,
              sidebarArtwork: true,
              radius: "10px",
              colors: { info: "#0969da" },
            },
          ]),
        ),
      ],
    ]);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    vi.resetModules();
    const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
    const palette = await import("../themePalette");
    const { startEnvironmentThemeRepaint } = await import("./useEnvironmentTheme");
    const stop = startEnvironmentThemeRepaint();
    try {
      expect(palette.getThemeDefinition("nightfall")?.label).toBe("Nightfall");
      expect(palette.themeAllowsSidebarArtwork("nightfall")).toBe(true);
      expect(palette.getThemeDefinition("nightfall")).toMatchObject({
        radius: "10px",
        statusColors: { dark: { info: "#0969da" } },
      });

      // The plugin that published it is gone: the server's first themes event is empty.
      publish(registry, []);
      expect(palette.getThemeDefinition("nightfall")).toBeNull();
      expect(store.has(ENVIRONMENT_THEMES_STORAGE_KEY)).toBe(false);

      publish(registry, [{ ...NIGHTFALL_THEME, name: "Nightfall 2" }]);
      expect(JSON.parse(store.get(ENVIRONMENT_THEMES_STORAGE_KEY) ?? "[]")[0]?.label).toBe(
        "Nightfall 2",
      );
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
  });

  it("repaints when the environment publishes themes nothing has read yet", async () => {
    vi.resetModules();
    const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
    const { startEnvironmentThemeRepaint } = await import("./useEnvironmentTheme");
    const stop = startEnvironmentThemeRepaint();
    try {
      publish(registry, [NIGHTFALL_THEME]);
      expect(refreshTheme).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
