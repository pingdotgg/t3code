import {
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type DesktopBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createLocalApi } from "./localApi";

const { showContextMenuFallbackMock, dismissContextMenuMock, requestConfirmDialogMock } =
  vi.hoisted(() => ({
    showContextMenuFallbackMock:
      vi.fn<
        <T extends string>(
          items: readonly ContextMenuItem<T>[],
          position?: { x: number; y: number },
        ) => Promise<T | null>
      >(),
    dismissContextMenuMock: vi.fn<() => void>(),
    requestConfirmDialogMock:
      vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>(),
  }));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

const styledContextMenuState = vi.hoisted(() => ({ enabled: false }));
const ensureClientSettingsHydratedMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: ensureClientSettingsHydratedMock,
  getClientSettings: () => ({ styledContextMenuEnabled: styledContextMenuState.enabled }),
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
  styledContextMenuState.enabled = false;
  ensureClientSettingsHydratedMock.mockResolvedValue(undefined);
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
  it("uses the native context menu on desktop when Styled Context Menu is disabled", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    testWindow().desktopBridge = { showContextMenu } as unknown as DesktopBridge;
    const items = [{ id: "delete", label: "Delete" }] as const;
    const position = { x: 1, y: 2 };

    await expect(createLocalApi().contextMenu.show(items, position)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, position);
    expect(showContextMenuFallbackMock).not.toHaveBeenCalled();
  });

  it("uses the styled fallback on desktop when Styled Context Menu is enabled", async () => {
    styledContextMenuState.enabled = true;
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    testWindow().desktopBridge = { showContextMenu } as unknown as DesktopBridge;
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(createLocalApi().contextMenu.show(items, { x: 1, y: 2 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 1, y: 2 });
    expect(showContextMenu).not.toHaveBeenCalled();
  });

  it("dismisses the styled fallback on desktop when Styled Context Menu is enabled", async () => {
    styledContextMenuState.enabled = true;
    testWindow().desktopBridge = { showContextMenu: vi.fn() } as unknown as DesktopBridge;

    await createLocalApi().contextMenu.close();

    expect(dismissContextMenuMock).toHaveBeenCalledOnce();
  });

  it("abandons a desktop show that close invalidates while the preference read is pending", async () => {
    styledContextMenuState.enabled = true;
    let resolveHydration!: () => void;
    let notifyHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => {
      notifyHydrationStarted = resolve;
    });
    ensureClientSettingsHydratedMock.mockImplementation(() => {
      notifyHydrationStarted();
      return new Promise<void>((resolve) => {
        resolveHydration = resolve;
      });
    });
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    testWindow().desktopBridge = { showContextMenu } as unknown as DesktopBridge;
    const api = createLocalApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    const pendingShow = api.contextMenu.show(items);
    await hydrationStarted;
    await api.contextMenu.close();
    resolveHydration();

    await expect(pendingShow).resolves.toBeNull();
    expect(showContextMenuFallbackMock).not.toHaveBeenCalled();
    expect(showContextMenu).not.toHaveBeenCalled();
  });

  it("abandons a desktop show that a newer show supersedes", async () => {
    styledContextMenuState.enabled = true;
    let resolveHydration!: () => void;
    let notifyHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => {
      notifyHydrationStarted = resolve;
    });
    ensureClientSettingsHydratedMock.mockImplementationOnce(() => {
      notifyHydrationStarted();
      return new Promise<void>((resolve) => {
        resolveHydration = resolve;
      });
    });
    showContextMenuFallbackMock.mockResolvedValue("b");
    const showContextMenu = vi.fn().mockResolvedValue("b");
    testWindow().desktopBridge = { showContextMenu } as unknown as DesktopBridge;
    const api = createLocalApi();

    const firstShow = api.contextMenu.show([{ id: "a", label: "A" }] as const);
    await hydrationStarted;
    const secondShow = api.contextMenu.show([{ id: "b", label: "B" }] as const);
    resolveHydration();

    await expect(firstShow).resolves.toBeNull();
    await expect(secondShow).resolves.toBe("b");
    expect(showContextMenuFallbackMock).toHaveBeenCalledOnce();
    expect(showContextMenu).not.toHaveBeenCalled();
  });

  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });
});
