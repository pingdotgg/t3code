import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "t3code:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "t3code:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "t3-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for t3code:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "t3code:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "t3code:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});

describe("onboarding theme", () => {
  it("clears custom palettes and restores the latest selected theme", async () => {
    const storage = createStorage();
    const classes = new Set<string>();
    const styleValues = new Map<string, string>();
    const root = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, force?: boolean) => {
          const next = force ?? !classes.has(name);
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
      },
      dataset: {} as Record<string, string>,
      offsetHeight: 0,
      style: {
        backgroundColor: "",
        removeProperty: (name: string) => styleValues.delete(name),
        setProperty: (name: string, value: string) => styleValues.set(name, value),
      },
    };
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribe(() => undefined);
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("document", {
      body: { style: { backgroundColor: "" } },
      createElement: () => ({ name: "", setAttribute: () => undefined }),
      documentElement: root,
      head: { append: () => undefined },
      querySelector: () => null,
      querySelectorAll: () => [],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "rgb(0, 0, 0)",
      getPropertyValue: () => "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    const { EMBER_THEME, installCustomTheme } = await import("../themePalette");
    const firstTheme = installCustomTheme({
      ...EMBER_THEME,
      id: "first-custom",
      label: "First Custom",
    });
    const secondTheme = installCustomTheme({
      ...EMBER_THEME,
      id: "second-custom",
      label: "Second Custom",
      colors: { ...EMBER_THEME.colors, error: "#123456" },
    });
    storage.setItem("t3code:theme", firstTheme.id);

    const { mountOnboardingTheme, useTheme } = await import("./useTheme");
    expect(root.dataset.themeId).toBe(firstTheme.id);
    expect(styleValues.get("--app-theme-error")).toBe(firstTheme.colors.error);

    const cleanup = mountOnboardingTheme();
    expect(root.dataset.themeId).toBeUndefined();
    expect(styleValues.size).toBe(0);

    expect(useTheme().setTheme(secondTheme.id)).toBe(true);
    expect(root.dataset.themeId).toBeUndefined();
    expect(styleValues.size).toBe(0);

    cleanup();
    expect(root.dataset.themeId).toBe(secondTheme.id);
    expect(styleValues.get("--app-theme-error")).toBe(secondTheme.colors.error);
  });

  it("stays dark during storage changes and restores the latest saved theme", async () => {
    const storage = createStorage();
    storage.setItem("t3code:theme", "light");
    const classes = new Set<string>();
    const styleValues = new Map<string, string>();
    const style = {
      backgroundColor: "",
      removeProperty: (name: string) => styleValues.delete(name),
      setProperty: (name: string, value: string) => styleValues.set(name, value),
    };
    const root = {
      classList: {
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, force?: boolean) => {
          const next = force ?? !classes.has(name);
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
      },
      dataset: {} as Record<string, string>,
      offsetHeight: 0,
      style,
    };
    const body = { style: { backgroundColor: "" } };
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    const setDesktopTheme = vi.fn().mockResolvedValue(undefined);
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribe(() => undefined);
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
      desktopBridge: { setTheme: setDesktopTheme },
    });
    vi.stubGlobal("document", {
      body,
      createElement: () => ({ name: "", setAttribute: () => undefined }),
      documentElement: root,
      head: { append: () => undefined },
      querySelector: () => null,
      querySelectorAll: () => [],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor:
        root.dataset.onboardingSurface !== undefined
          ? "rgb(0, 0, 0)"
          : classes.has("dark")
            ? "rgb(10, 10, 10)"
            : "rgb(255, 255, 255)",
      getPropertyValue: () => "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    const { mountOnboardingTheme, useTheme } = await import("./useTheme");
    expect(useTheme().resolvedTheme).toBe("light");
    const cleanup = mountOnboardingTheme();

    expect(root.dataset.onboardingSurface).toBe("");
    expect(classes.has("dark")).toBe(true);
    expect(root.style.backgroundColor).toBe("#000");
    expect(body.style.backgroundColor).toBe("#000");
    expect(useTheme().resolvedTheme).toBe("dark");
    expect(setDesktopTheme).toHaveBeenLastCalledWith("dark");

    storage.setItem("t3code:theme", "dark");
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    storage.setItem("t3code:theme", "light");
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    expect(classes.has("dark")).toBe(true);
    expect(useTheme().resolvedTheme).toBe("dark");

    cleanup();
    expect(root.dataset.onboardingSurface).toBeUndefined();
    expect(classes.has("dark")).toBe(false);
    expect(root.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(body.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(storage.getItem("t3code:theme")).toBe("light");
    expect(useTheme().resolvedTheme).toBe("light");
    expect(setDesktopTheme).toHaveBeenLastCalledWith("light");
  });
});
