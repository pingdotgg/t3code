import type { EnvironmentThemeFile, DesktopLocalThemeState } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const darkTheme = {
  name: "Desktop palette",
  appearance: "dark",
  canvas: "#123456",
  accent: "#abcdef",
} as const satisfies EnvironmentThemeFile;
const lightTheme = { ...darkTheme, appearance: "light", canvas: "#f0e8d0" } as const;

async function setup(withDefaultAdoption = false) {
  const storage = new Map<string, string>([
    ["t3code:theme", "t3-chat"],
    ["t3code:theme-appearance-mode", "light"],
    ["t3code:theme-halves:v1", JSON.stringify({ light: "t3-chat", dark: "t3-iris" })],
    ["draft", "unfinished message"],
  ]);
  const originalStorage = new Map(storage);
  const styles = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (k: string, v: string) => styles.set(k, v),
      removeProperty: (k: string) => styles.delete(k),
    },
    classList: {
      add: (k: string) => classes.add(k),
      remove: (k: string) => classes.delete(k),
      toggle: (k: string, on: boolean) => (on ? classes.add(k) : classes.delete(k)),
    },
  };
  let notify: ((theme: DesktopLocalThemeState) => void) | undefined;
  let rejectInitial: ((error: Error) => void) | undefined;
  let resolveInitial: ((theme: DesktopLocalThemeState) => void) | undefined;
  const initial = new Promise<DesktopLocalThemeState>((resolve, reject) => {
    rejectInitial = reject;
    resolveInitial = resolve;
  });
  const unsubscribe = vi.fn();
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    desktopBridge: {
      getLocalTheme: () => initial,
      onLocalTheme: (listener: typeof notify) => {
        notify = listener;
        return unsubscribe;
      },
      setTheme: vi.fn().mockResolvedValue(undefined),
    },
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  const effects: Array<() => void | (() => void)> = [];
  vi.doMock("react", () => ({
    useCallback: <T>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  }));
  const { useDesktopLocalThemeSync } = await import("./useDesktopLocalTheme");
  const { useTheme } = await import("./useTheme");
  const palette = await import("../themePalette");
  if (withDefaultAdoption) {
    vi.doMock("../state/server", () => ({ primaryServerSettingsAtom: "settings" }));
    vi.doMock("../state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "environment" }));
    vi.doMock("@effect/atom-react", () => ({
      useAtomValue: (atom: string) =>
        atom === "settings"
          ? { defaultTheme: "iris", defaultThemeSetAt: "one" }
          : "remote-environment",
    }));
  }
  useDesktopLocalThemeSync();
  if (withDefaultAdoption) {
    const { useDefaultThemeAdoption } = await import("./useDefaultTheme");
    useDefaultThemeAdoption();
  }
  const cleanups = effects.splice(0).map((effect) => effect());
  return {
    storage,
    originalStorage,
    styles,
    root,
    classes,
    palette,
    useTheme,
    publish: (theme: EnvironmentThemeFile | null) => notify?.({ enabled: true, theme }),
    initial: async (theme: EnvironmentThemeFile | null) => {
      resolveInitial?.({ enabled: true, theme });
      await initial;
      await Promise.resolve();
    },
    rejectInitial: async () => {
      rejectInitial?.(new Error("IPC startup failed"));
      await initial.catch(() => {});
      await Promise.resolve();
    },
    cleanup: () => cleanups.forEach((cleanup) => cleanup?.()),
    unsubscribe,
    flushEffects: () => {
      effects.splice(0).forEach((effect) => effect());
    },
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("@effect/atom-react");
  vi.doUnmock("../state/server");
  vi.doUnmock("../state/primaryEnvironment");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop-local theme following", () => {
  it("retints dark and light without an environment or changes to saved preferences and drafts", async () => {
    const app = await setup();
    await app.initial(darkTheme);
    const variable = app.palette.getThemeColorVariable("canvas");
    expect(app.root.dataset.themeId).toBe(app.palette.DESKTOP_LOCAL_THEME_ID);
    expect(app.classes.has("dark")).toBe(true);
    expect(app.useTheme().resolvedTheme).toBe("dark");
    const darkCanvas = app.styles.get(variable);
    app.publish(lightTheme);
    expect(app.classes.has("dark")).toBe(false);
    expect(app.useTheme().resolvedTheme).toBe("light");
    expect(app.styles.get(variable)).not.toBe(darkCanvas);
    expect(app.storage).toEqual(app.originalStorage);
    app.publish(null);
    expect(app.root.dataset.themeId).toBe("t3-chat");
    expect(app.storage).toEqual(app.originalStorage);
  });

  it("lets a manual selection win until the next desktop palette change", async () => {
    const app = await setup();
    await app.initial(darkTheme);
    expect(app.useTheme().setTheme("t3-iris")).toBe(true);
    expect(app.root.dataset.themeId).toBe("iris");
    app.publish(lightTheme);
    expect(app.root.dataset.themeId).toBe(app.palette.DESKTOP_LOCAL_THEME_ID);
    expect(app.classes.has("dark")).toBe(false);
    expect(app.storage.get("t3code:theme")).toBe("t3-iris");
  });

  it("honors theme cards and appearance controls, with rollback when storage fails", async () => {
    const app = await setup();
    await app.initial(darkTheme);
    expect(app.useTheme().setThemeHalf("light", "iris")).toBe(true);
    expect(app.root.dataset.themeId).toBe("iris");
    app.publish(darkTheme);
    expect(app.useTheme().setAppearanceMode("light")).toBe(true);
    expect(app.classes.has("dark")).toBe(false);
    app.publish(darkTheme);
    const savedPalette = app.palette.getDesktopLocalTheme();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const storageWrite = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(app.useTheme().setTheme("iris")).toBe(false);
    expect(app.palette.getDesktopLocalTheme()).toBe(savedPalette);
    app.useTheme().refreshTheme();
    expect(app.root.dataset.themeId).toBe(app.palette.DESKTOP_LOCAL_THEME_ID);
    storageWrite.mockRestore();
    error.mockRestore();
  });

  it("does not replay the startup palette over a manual choice", async () => {
    const app = await setup();
    expect(app.useTheme().setTheme("iris")).toBe(true);
    await app.initial(darkTheme);
    expect(app.root.dataset.themeId).toBe("iris");
    app.publish(lightTheme);
    expect(app.root.dataset.themeId).toBe(app.palette.DESKTOP_LOCAL_THEME_ID);
  });

  it("keeps environment defaults from changing saved preferences while loading or following a local file", async () => {
    const app = await setup(true);
    const { useDefaultThemeAdoption } = await import("./useDefaultTheme");
    useDefaultThemeAdoption();
    app.flushEffects();
    expect(app.storage).toEqual(app.originalStorage);
    await app.initial(darkTheme);
    useDefaultThemeAdoption();
    app.flushEffects();
    expect(app.storage).toEqual(app.originalStorage);
    app.useTheme().setTheme("t3-chat");
    const savedChoice = new Map(app.storage);
    useDefaultThemeAdoption();
    app.flushEffects();
    expect(app.storage).toEqual(savedChoice);
    expect(app.root.dataset.themeId).toBe("t3-chat");
  });

  it("keeps a newer live palette when an older startup snapshot arrives late", async () => {
    const app = await setup();
    app.publish(lightTheme);
    const before = new Map(app.styles);
    await app.initial(darkTheme);
    expect(app.classes.has("dark")).toBe(false);
    expect(app.styles).toEqual(before);
  });

  it("keeps a live source configured when startup IPC fails later", async () => {
    const app = await setup();
    app.publish(lightTheme);
    await app.rejectInitial();
    expect(app.palette.getDesktopLocalThemeSource()).toBe("configured");
    expect(app.root.dataset.themeId).toBe(app.palette.DESKTOP_LOCAL_THEME_ID);
  });

  it("preserves theme editor previews and applies the newest palette on leaving the preview", async () => {
    const app = await setup();
    await app.initial(darkTheme);
    const colors = { ...app.palette.getDefaultThemeColors("light"), canvas: "#fedcba" };
    app.palette.applyThemeColorPreview(colors, "light");
    app.publish(lightTheme);
    expect(app.root.dataset.themeId).toBe(app.palette.THEME_PREVIEW_ID);
    expect(app.styles.get(app.palette.getThemeColorVariable("canvas"))).toBe(colors.canvas);
    app.useTheme().refreshTheme();
    expect(app.root.dataset.themeId).toBe(app.palette.DESKTOP_LOCAL_THEME_ID);
    expect(app.classes.has("dark")).toBe(false);
  });

  it("restores saved appearance on cleanup and ignores late IPC results", async () => {
    const app = await setup();
    app.publish(darkTheme);
    app.cleanup();
    await app.initial(lightTheme);
    app.publish(darkTheme);
    expect(app.unsubscribe).toHaveBeenCalledOnce();
    expect(app.root.dataset.themeId).toBe("t3-chat");
    expect(app.storage).toEqual(app.originalStorage);
  });
});
