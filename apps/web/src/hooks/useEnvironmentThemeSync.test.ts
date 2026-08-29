import type { EnvironmentTheme } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const NIGHTFALL_THEME = {
  id: "nightfall",
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
} as const satisfies EnvironmentTheme;

const LIGHT_THEME = {
  ...NIGHTFALL_THEME,
  appearance: "light",
  canvas: "#eff1f5",
} as const satisfies EnvironmentTheme;

async function setupThemeSync(mode: "dark" | "system" = "dark") {
  const storage = new Map<string, string>([["t3code:theme", NIGHTFALL_THEME.id]]);
  const styles = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => styles.set(name, value),
      removeProperty: (name: string) => styles.delete(name),
    },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) =>
        enabled ? classes.add(name) : classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn());

  let published: ReadonlyArray<EnvironmentTheme> = [NIGHTFALL_THEME];
  let readSnapshot: (() => unknown) | undefined;
  const effects: Array<() => void> = [];
  const lastPublished: { current: ReadonlyArray<EnvironmentTheme> | null } = { current: null };
  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useEffect: (effect: () => void) => effects.push(effect),
    useRef: () => lastPublished,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => {
      readSnapshot = getSnapshot;
      return getSnapshot();
    },
  }));
  vi.doMock("@effect/atom-react", () => ({ useAtomValue: () => published }));
  vi.doMock("../state/server", () => ({ primaryServerEnvironmentThemesAtom: {} }));

  const palette = await import("../themePalette");
  storage.set(palette.THEME_APPEARANCE_MODE_STORAGE_KEY, mode);
  const { useTheme } = await import("./useTheme");
  const { useEnvironmentThemeSync } = await import("./useEnvironmentTheme");
  const flushEffects = () => {
    for (const effect of effects.splice(0)) effect();
  };
  const publish = (themes: ReadonlyArray<EnvironmentTheme>) => {
    published = themes;
    useEnvironmentThemeSync();
    flushEffects();
    // A changed store snapshot also runs the consumer's passive theme effect.
    const theme = useTheme();
    flushEffects();
    return theme;
  };
  publish(published);

  return { publish, palette, root, styles, readSnapshot: () => readSnapshot?.() };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("@effect/atom-react");
  vi.doUnmock("../state/server");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("published theme refresh", () => {
  it.each(["dark", "system"] as const)(
    "updates the React snapshot when appearance changes in %s mode",
    async (mode) => {
      const { publish, root, readSnapshot } = await setupThemeSync(mode);
      const darkSnapshot = readSnapshot();

      expect(publish([LIGHT_THEME]).resolvedTheme).toBe("light");
      expect(root.classList.contains("dark")).toBe(false);
      const lightSnapshot = readSnapshot();
      expect(lightSnapshot).not.toBe(darkSnapshot);

      expect(publish([NIGHTFALL_THEME]).resolvedTheme).toBe("dark");
      expect(root.classList.contains("dark")).toBe(true);
      expect(readSnapshot()).not.toBe(lightSnapshot);
    },
  );

  it("keeps the React snapshot stable for color-only changes", async () => {
    const { publish, palette, styles, readSnapshot } = await setupThemeSync();
    const before = readSnapshot();
    const accentVariable = palette.getThemeColorVariable("accent");
    const previousAccent = styles.get(accentVariable);

    publish([{ ...NIGHTFALL_THEME, accent: "#ff0000" }]);

    expect(styles.get(accentVariable)).not.toBe(previousAccent);
    expect(readSnapshot()).toBe(before);
  });

  it("keeps a draft visible while updating the stored selection underneath it", async () => {
    const { publish, palette, root, styles } = await setupThemeSync();
    const draft = { ...palette.getDefaultThemeColors("light"), canvas: "#234567" };
    palette.applyThemeColorPreview(draft, "light");
    const canvasVariable = palette.getThemeColorVariable("canvas");

    const expectPreview = () => {
      expect(root.dataset.themeId).toBe(palette.THEME_PREVIEW_ID);
      expect(styles.get(canvasVariable)).toBe(draft.canvas);
      expect(root.classList.contains("dark")).toBe(false);
    };
    expect(publish([LIGHT_THEME]).resolvedTheme).toBe("light");
    expectPreview();
    publish([LIGHT_THEME, { ...NIGHTFALL_THEME, id: "unused-theme" }]);
    expectPreview();
    expect(publish([]).theme).toBe("system");
    expectPreview();

    const current = publish([{ ...NIGHTFALL_THEME, canvas: "#112233" }]);
    expect(current.theme).toBe(NIGHTFALL_THEME.id);
    expect(current.resolvedTheme).toBe("dark");
    expectPreview();

    current.refreshTheme();
    expect(root.dataset.themeId).toBe(NIGHTFALL_THEME.id);
    expect(styles.get(canvasVariable)).toBe(
      palette.getThemeDefinition(NIGHTFALL_THEME.id)?.colors.canvas,
    );
    expect(root.classList.contains("dark")).toBe(true);
    expect(palette.getThemePreviewSidebarArtwork()).toBeNull();
  });

  it("keeps a draft visible when default adoption changes the theme and appearance", async () => {
    const { publish, palette, root, readSnapshot } = await setupThemeSync();
    const current = publish([NIGHTFALL_THEME]);
    palette.applyThemeColorPreview(palette.getDefaultThemeColors("dark"), "dark");

    expect(current.setTheme("ocean")).toBe(true);
    expect(current.setAppearanceMode("light")).toBe(true);
    expect(readSnapshot()).toMatchObject({
      theme: "ocean",
      appearanceMode: "light",
      resolvedTheme: "light",
    });
    expect(root.dataset.themeId).toBe(palette.THEME_PREVIEW_ID);
    expect(root.classList.contains("dark")).toBe(true);

    current.refreshTheme();
    expect(root.dataset.themeId).toBe("ocean");
    expect(root.classList.contains("dark")).toBe(false);
    expect(palette.getThemePreviewSidebarArtwork()).toBeNull();
  });
});
