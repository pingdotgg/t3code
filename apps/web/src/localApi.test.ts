import {
  DEFAULT_CLIENT_SETTINGS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
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
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("uses the browser context-menu fallback without a desktop bridge", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(createLocalApi().contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("uses the themed confirmation host when it is available", async () => {
    requestConfirmDialogMock.mockResolvedValue(true);
    const { createLocalApi } = await import("./localApi");
    const options = { variant: "destructive" } as const;

    await expect(createLocalApi().dialogs.confirm("Delete this thread?", options)).resolves.toBe(
      true,
    );
    expect(requestConfirmDialogMock).toHaveBeenCalledWith("Delete this thread?", options);
  });

  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });

  it("rejects opening System Settings when the desktop bridge is unavailable", async () => {
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().shell.openSystemSettings("full-disk-access")).rejects.toThrow(
      "Unable to open System Settings.",
    );
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
});
