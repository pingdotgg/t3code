import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fromId = vi.fn(() => null);
const mkdir = vi.fn(async () => undefined);
const writeFile = vi.fn(async () => undefined);

vi.mock("node:fs/promises", () => ({ mkdir, writeFile }));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/t3-code-test"),
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
  },
}));

describe("PreviewViewManager automation status", () => {
  beforeEach(() => {
    fromId.mockClear();
    mkdir.mockClear();
    writeFile.mockClear();
  });

  it("reports an unregistered webview as temporarily unavailable", async () => {
    const { PreviewViewManager } = await import("./preview-view-manager.ts");
    const manager = new PreviewViewManager();

    expect(manager.automationStatus("tab_1")).toEqual({
      available: false,
      visible: true,
      tabId: "tab_1",
      url: null,
      title: null,
      loading: false,
    });

    manager.createTab("tab_1");

    expect(manager.automationStatus("tab_1")).toEqual({
      available: false,
      visible: true,
      tabId: "tab_1",
      url: null,
      title: null,
      loading: false,
    });
    expect(fromId).not.toHaveBeenCalled();
  });

  it("captures a PNG screenshot into browser artifacts", async () => {
    const png = Buffer.from("preview-png");
    const capturePage = vi.fn(async () => ({ toPNG: () => png }));
    const listeners = new Map<string, (...args: never[]) => void>();
    fromId.mockReturnValue({
      id: 42,
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.com/",
      getTitle: () => "Example",
      isLoading: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn(),
      ipc: { on: vi.fn(), off: vi.fn() },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(async () => undefined),
        on: vi.fn(),
        off: vi.fn(),
      },
      capturePage,
    } as never);
    const { PreviewViewManager } = await import("./preview-view-manager.ts");
    const manager = new PreviewViewManager();
    manager.createTab("tab_1");
    manager.registerWebview("tab_1", 42);

    const artifact = await manager.captureScreenshot("tab_1");

    expect(capturePage).toHaveBeenCalledOnce();
    expect(mkdir).toHaveBeenCalledWith("/tmp/t3-code-test/browser-artifacts", {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
    expect(artifact).toMatchObject({
      tabId: "tab_1",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
    });
    expect(artifact.path).toMatch(/\/browser-artifacts\/browser-screenshot-[^.]+\.png$/);
  });
});
