import type { DesktopBridge, DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const { exposeInMainWorld, invoke, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn<(channel: string) => Promise<unknown>>(),
  sendSync: vi.fn(() => {
    throw new Error("Unexpected synchronous IPC");
  }),
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, sendSync },
  webFrame: {},
  webUtils: {},
}));

const primary: DesktopEnvironmentBootstrap = {
  id: "primary",
  label: "Windows",
  httpBaseUrl: "http://127.0.0.1:3773/",
  wsBaseUrl: "ws://127.0.0.1:3773/",
};
const secondary: DesktopEnvironmentBootstrap = {
  id: "wsl:Ubuntu",
  label: "WSL (Ubuntu)",
  httpBaseUrl: "http://127.0.0.1:3774/",
  wsBaseUrl: "ws://127.0.0.1:3774/",
};

type LocalEnvironmentBridge = Required<
  Pick<
    DesktopBridge,
    "refreshLocalEnvironment" | "getLocalEnvironmentBootstraps" | "getLocalEnvironmentEnabled"
  >
>;

describe("desktop local environment snapshot", () => {
  let bridge: LocalEnvironmentBridge;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // The macOS preload registers window-inset listeners as well.
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    invoke.mockImplementation(async (channel) => {
      if (channel === IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL) return [primary];
      if (channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) return true;
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });
    await import("./preload.ts");
    bridge = exposeInMainWorld.mock.calls.find(([name]) => name === "desktopBridge")![1];
  });

  afterEach(() => vi.unstubAllGlobals());

  it("initializes asynchronously and serves repeated topology reads without IPC", async () => {
    expect(() => bridge.getLocalEnvironmentBootstraps()).toThrow("not been initialized");
    expect(() => bridge.getLocalEnvironmentEnabled()).toThrow("not been initialized");

    await bridge.refreshLocalEnvironment();
    invoke.mockClear();
    for (let i = 0; i < 10; i += 1) {
      expect(bridge.getLocalEnvironmentBootstraps()).toEqual([primary]);
      expect(bridge.getLocalEnvironmentEnabled()).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(sendSync).not.toHaveBeenCalled();
  });

  it("keeps reads available while a slow refresh is pending and coalesces refreshes", async () => {
    await bridge.refreshLocalEnvironment();
    const response = Promise.withResolvers<readonly DesktopEnvironmentBootstrap[]>();
    invoke.mockImplementation(async (channel) =>
      channel === IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL ? response.promise : true,
    );
    invoke.mockClear();

    const first = bridge.refreshLocalEnvironment();
    const second = bridge.refreshLocalEnvironment();
    await Promise.resolve();
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([primary]);
    expect(bridge.getLocalEnvironmentEnabled()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sendSync).not.toHaveBeenCalled();

    response.resolve([primary, secondary]);
    await Promise.all([first, second]);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([primary, secondary]);
  });

  it("publishes enabled state and topology together, including an empty topology", async () => {
    await bridge.refreshLocalEnvironment();
    const enabled = Promise.withResolvers<boolean>();
    invoke.mockImplementation(async (channel) =>
      channel === IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL ? [] : enabled.promise,
    );

    const refresh = bridge.refreshLocalEnvironment();
    await Promise.resolve();
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([primary]);
    expect(bridge.getLocalEnvironmentEnabled()).toBe(true);

    enabled.resolve(false);
    await refresh;
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([]);
    expect(bridge.getLocalEnvironmentEnabled()).toBe(false);
  });

  it("preserves the snapshot after a failed refresh and accepts subsequent removal", async () => {
    await bridge.refreshLocalEnvironment();
    invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(bridge.refreshLocalEnvironment()).rejects.toThrow("IPC unavailable");
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([primary]);
    expect(bridge.getLocalEnvironmentEnabled()).toBe(true);

    invoke.mockResolvedValueOnce([]).mockResolvedValueOnce(true);
    await bridge.refreshLocalEnvironment();
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([]);
  });

  it("can retry a failed initial refresh without exposing a fabricated empty topology", async () => {
    invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(bridge.refreshLocalEnvironment()).rejects.toThrow("IPC unavailable");
    expect(() => bridge.getLocalEnvironmentBootstraps()).toThrow("not been initialized");

    await bridge.refreshLocalEnvironment();
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([primary]);
    expect(sendSync).not.toHaveBeenCalled();
  });
});
