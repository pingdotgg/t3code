import {
  DEFAULT_CLIENT_SETTINGS,
  type ContextMenuItem,
  type DesktopBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Reflect.deleteProperty(testWindow(), "nativeApi");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("keeps backend operations unavailable in the browser facade", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();

    await expect(api.server.getConfig()).rejects.toThrow(
      "Local backend API is unavailable before a backend is paired.",
    );
    await expect(api.shell.openInEditor("/tmp", "cursor")).rejects.toThrow(
      "Local backend API is unavailable before a backend is paired.",
    );
  });

  it("uses the browser context-menu fallback without a desktop bridge", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(createLocalApi().contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("delegates host capabilities and persistence to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    const getClientSettings = vi.fn().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    testWindow().desktopBridge = {
      showContextMenu,
      pickFolder,
      getClientSettings,
      setClientSettings,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    await expect(api.dialogs.pickFolder({ initialPath: "/tmp" })).resolves.toBe("/tmp/project");
    await expect(api.persistence.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await api.persistence.setClientSettings(DEFAULT_CLIENT_SETTINGS);

    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp" });
    expect(getClientSettings).toHaveBeenCalledTimes(1);
    expect(setClientSettings).toHaveBeenCalledWith(DEFAULT_CLIENT_SETTINGS);
  });

  it("persists client settings in browser storage", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
    };

    await api.persistence.setClientSettings(settings);
    await expect(api.persistence.getClientSettings()).resolves.toEqual(settings);
  });

  it("migrates valid browser client settings when the desktop file is missing", async () => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
    };
    const getClientSettings = vi.fn().mockResolvedValue(null);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    testWindow().localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
    testWindow().desktopBridge = {
      getClientSettings,
      setClientSettings,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().persistence.getClientSettings()).resolves.toEqual(settings);
    expect(setClientSettings).toHaveBeenCalledWith(settings);
    expect(testWindow().localStorage.getItem("t3code:client-settings:v1")).toBeNull();
  });

  it("does not migrate malformed browser client settings into the desktop file", async () => {
    const getClientSettings = vi.fn().mockResolvedValue(null);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    testWindow().localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({ timestampFormat: "sometimes" }),
    );
    testWindow().desktopBridge = {
      getClientSettings,
      setClientSettings,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().persistence.getClientSettings()).resolves.toBeNull();
    expect(setClientSettings).not.toHaveBeenCalled();
  });

  it("migrates valid renderer state from localStorage when its desktop file is missing", async () => {
    const getRendererState = vi.fn().mockResolvedValue(null);
    const setRendererState = vi.fn().mockResolvedValue(undefined);
    const rawState = '{"projectOrder":["project-b","project-a"]}';
    testWindow().localStorage.setItem("t3code:ui-state:v1", rawState);
    testWindow().desktopBridge = {
      getRendererState,
      setRendererState,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().persistence.getRendererState("ui-state")).resolves.toBe(rawState);
    expect(setRendererState).toHaveBeenCalledWith("ui-state", rawState);
    expect(testWindow().localStorage.getItem("t3code:ui-state:v1")).toBeNull();
  });

  it("migrates legacy sticky preferences without deleting persisted composer drafts", async () => {
    const getRendererState = vi.fn().mockResolvedValue(null);
    const setRendererState = vi.fn().mockResolvedValue(undefined);
    const legacyDrafts = JSON.stringify({
      version: 8,
      state: {
        draftsByThreadKey: {
          "environment:thread": {
            prompt: "keep this draft",
            attachments: [],
          },
        },
        stickyModelSelectionByProvider: {
          codex: {
            instanceId: "codex",
            model: "gpt-5.6-sol",
          },
        },
        stickyActiveProvider: "codex",
      },
    });
    testWindow().localStorage.setItem("t3code:composer-drafts:v1", legacyDrafts);
    testWindow().desktopBridge = {
      getRendererState,
      setRendererState,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");
    const migrated = await createLocalApi().persistence.getRendererState("composer-preferences");

    expect(migrated === null ? null : JSON.parse(migrated)).toEqual({
      version: 1,
      stickyModelSelectionByProvider: {
        codex: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
        },
      },
      stickyActiveProvider: "codex",
    });
    expect(setRendererState).toHaveBeenCalledWith("composer-preferences", migrated);
    expect(testWindow().localStorage.getItem("t3code:composer-drafts:v1")).toBe(legacyDrafts);
  });

  it("keeps renderer state in localStorage when no desktop bridge is present", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const rawState = '{"state":{"stickyActiveProvider":"codex"},"version":8}';

    await api.persistence.setRendererState("composer-preferences", rawState);

    await expect(api.persistence.getRendererState("composer-preferences")).resolves.toBe(rawState);
    await api.persistence.setRendererState("composer-preferences", null);
    await expect(api.persistence.getRendererState("composer-preferences")).resolves.toBeNull();
  });

  it("prefers the native LocalApi when one is injected", async () => {
    const nativeApi = { dialogs: {} };
    testWindow().nativeApi = nativeApi as never;
    const { readLocalApi } = await import("./localApi");

    expect(readLocalApi()).toBe(nativeApi);
  });
});
