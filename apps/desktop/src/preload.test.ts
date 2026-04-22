import type { DesktopBridge } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPEN_PROJECT_PATH_CHANNEL = "desktop:open-project-path";

const { exposeInMainWorldMock, ipcRendererMock, ipcListeners } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    exposeInMainWorldMock: vi.fn(),
    ipcRendererMock: {
      invoke: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        const channelListeners = listeners.get(channel) ?? new Set<(...args: unknown[]) => void>();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(listener);
      }),
      sendSync: vi.fn(),
    },
    ipcListeners: listeners,
  };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
  ipcRenderer: ipcRendererMock,
}));

function emitIpc(channel: string, ...args: unknown[]): void {
  for (const listener of ipcListeners.get(channel) ?? []) {
    listener({} as Electron.IpcRendererEvent, ...args);
  }
}

async function loadDesktopBridge(): Promise<DesktopBridge> {
  vi.resetModules();
  await import("./preload.ts");
  return exposeInMainWorldMock.mock.calls[0]?.[1] as DesktopBridge;
}

describe("desktop preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcListeners.clear();
  });

  it("buffers open-project-path IPC until the renderer subscribes", async () => {
    const bridge = await loadDesktopBridge();
    emitIpc(OPEN_PROJECT_PATH_CHANNEL, "/tmp/project-sample");
    emitIpc(OPEN_PROJECT_PATH_CHANNEL, "/tmp/project-other");
    emitIpc(OPEN_PROJECT_PATH_CHANNEL, { path: "/tmp/not-a-string" });

    const listener = vi.fn();
    bridge.onOpenProjectPath(listener);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, "/tmp/project-sample");
    expect(listener).toHaveBeenNthCalledWith(2, "/tmp/project-other");
  });

  it("registers for open-project-path IPC as preload initializes", async () => {
    await loadDesktopBridge();

    expect(ipcRendererMock.on).toHaveBeenCalledWith(
      OPEN_PROJECT_PATH_CHANNEL,
      expect.any(Function),
    );
  });

  it("delivers open-project-path IPC directly after subscription", async () => {
    const bridge = await loadDesktopBridge();
    const listener = vi.fn();

    bridge.onOpenProjectPath(listener);
    emitIpc(OPEN_PROJECT_PATH_CHANNEL, "/tmp/project-sample");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("/tmp/project-sample");
  });

  it("does not notify unsubscribed open-project-path listeners", async () => {
    const bridge = await loadDesktopBridge();
    const listener = vi.fn();

    const unsubscribe = bridge.onOpenProjectPath(listener);
    unsubscribe();
    emitIpc(OPEN_PROJECT_PATH_CHANNEL, "/tmp/project-sample");

    expect(listener).not.toHaveBeenCalled();
  });
});
