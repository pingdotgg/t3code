import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it("persists client settings in browser storage", async () => {
    getTestWindow();
    const { readBrowserClientSettings, writeBrowserClientSettings } =
      await import("./clientPersistenceStorage");
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "24-hour" as const,
    };

    writeBrowserClientSettings(settings);

    expect(readBrowserClientSettings()).toEqual(settings);
  });

  it("reports structured decode failures while preserving the fallback", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem("t3code:client-settings:v1", "not-json");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "Could not read persisted client settings.",
      expect.objectContaining({
        _tag: "LocalStorageOperationError",
        operation: "decode",
        storageKey: "t3code:client-settings:v1",
        cause: expect.anything(),
      }),
    );
  });

  it("defaults word wrap on and discards obsolete wrapping preferences", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        chatWordWrap: false,
        diffWordWrap: false,
      }),
    );
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");
    const settings = readBrowserClientSettings();

    expect(settings).toEqual(
      expect.objectContaining({
        wordWrap: true,
      }),
    );
    expect(settings).not.toHaveProperty("chatWordWrap");
    expect(settings).not.toHaveProperty("diffWordWrap");
  });
});
