import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fromId = vi.fn(() => null);
const mkdir = vi.fn(async () => undefined);
const writeFile = vi.fn(async () => undefined);
const showItemInFolder = vi.fn();
const writeImage = vi.fn();
const createFromPath = vi.fn(() => ({ isEmpty: () => false }));
const webviewSend = vi.fn();

vi.mock("node:fs/promises", () => ({ mkdir, writeFile }));

vi.mock("electron", () => ({
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromPath,
  },
  session: {
    fromPartition: vi.fn(),
  },
  shell: {
    showItemInFolder,
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
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  it("reports an unregistered webview as temporarily unavailable", async () => {
    const { PreviewViewManager } = (await import("./Manager.ts")).__testing;
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
      getURL: () => "https://example.com:8443/path?query=value",
      getTitle: () => "Example",
      isLoading: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn(),
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
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
    const { PreviewViewManager } = (await import("./Manager.ts")).__testing;
    const manager = new PreviewViewManager();
    manager.configureArtifactDirectory("/tmp/t3/dev/browser-artifacts");
    manager.createTab("tab_1");
    manager.registerWebview("tab_1", 42);

    expect(webviewSend).toHaveBeenCalledWith(
      "preview:annotation-theme",
      expect.objectContaining({
        colorScheme: "light",
        primary: "oklch(0.488 0.217 264)",
      }),
    );

    const artifact = await manager.captureScreenshot("tab_1");

    expect(capturePage).toHaveBeenCalledOnce();
    expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts", {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
    expect(artifact).toMatchObject({
      tabId: "tab_1",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
    });
    expect(artifact.path).toMatch(
      /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
    );
  });

  it("reveals only files inside the configured browser artifact directory", async () => {
    const { PreviewViewManager } = (await import("./Manager.ts")).__testing;
    const manager = new PreviewViewManager();
    manager.configureArtifactDirectory("/tmp/t3/dev/browser-artifacts");

    manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

    expect(showItemInFolder).toHaveBeenCalledWith(
      "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
    );
    expect(() => manager.revealArtifact("/tmp/t3/dev/settings.json")).toThrow(
      "outside the configured artifact directory",
    );
  });

  it("copies screenshot artifacts to the system clipboard", async () => {
    const { PreviewViewManager } = (await import("./Manager.ts")).__testing;
    const manager = new PreviewViewManager();
    manager.configureArtifactDirectory("/tmp/t3/dev/browser-artifacts");
    const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

    manager.copyArtifactToClipboard(artifactPath);

    expect(createFromPath).toHaveBeenCalledWith(artifactPath);
    expect(writeImage).toHaveBeenCalledOnce();
    expect(() => manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json")).toThrow(
      "outside the configured artifact directory",
    );
  });

  it("emits the resolved pointer target before dispatching an automation click", async () => {
    let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
    const activity: string[] = [];
    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { width: 800, height: 600 },
          },
        };
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        activity.push("mousePressed");
        humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
      }
      return undefined;
    });
    fromId.mockReturnValue({
      id: 42,
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isLoading: () => false,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      ipc: {
        on: vi.fn((channel: string, listener: typeof humanInput) => {
          if (channel === "preview:human-input") humanInput = listener;
        }),
        off: vi.fn(),
      },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand,
        on: vi.fn(),
        off: vi.fn(),
      },
    } as never);
    const { PreviewViewManager } = (await import("./Manager.ts")).__testing;
    const manager = new PreviewViewManager();
    manager.onPointerEvent((event) => activity.push(event.phase));
    manager.createTab("tab_1");
    manager.registerWebview("tab_1", 42);

    await manager.automationClick("tab_1", { x: 120, y: 80 });

    expect(activity).toEqual(["move", "click", "mousePressed"]);
    expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 120,
      y: 80,
      button: "left",
      clickCount: 1,
    });
    expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 120,
      y: 80,
      button: "left",
      clickCount: 1,
    });
  });

  it("still interrupts agent control for a different human pointer event", async () => {
    let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
    const sendCommand = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { width: 800, height: 600 },
          },
        };
      }
      if (method === "Input.dispatchMouseEvent") {
        humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
      }
      return undefined;
    });
    fromId.mockReturnValue({
      id: 42,
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isLoading: () => false,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      ipc: {
        on: vi.fn((channel: string, listener: typeof humanInput) => {
          if (channel === "preview:human-input") humanInput = listener;
        }),
        off: vi.fn(),
      },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand,
        on: vi.fn(),
        off: vi.fn(),
      },
    } as never);
    const { PreviewViewManager } = (await import("./Manager.ts")).__testing;
    const manager = new PreviewViewManager();
    manager.createTab("tab_1");
    manager.registerWebview("tab_1", 42);

    await expect(manager.automationClick("tab_1", { x: 120, y: 80 })).rejects.toMatchObject({
      name: "PreviewAutomationControlInterruptedError",
    });
  });
});
