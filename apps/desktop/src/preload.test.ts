import type { DesktopBridge } from "@t3tools/contracts";
import { ipcRenderer } from "electron";
import { expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const { exposed, sendSync } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  sendSync: vi.fn((channel: string): unknown =>
    channel === "desktop:get-local-environment-enabled" ? true : [],
  ),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api),
  },
  ipcRenderer: {
    sendSync,
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: () => "" },
}));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));

it("topology polling reads the cache and refreshes it without synchronous IPC", async () => {
  vi.stubGlobal("window", {
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vi.stubGlobal("document", {
    addEventListener: () => {},
    fullscreenElement: null,
    documentElement: { style: { setProperty: () => {} } },
  });
  await import("./preload.ts");
  const bridge = exposed.get("desktopBridge") as DesktopBridge;
  sendSync.mockClear();

  // sendSync freezes the renderer until main answers; only the first read may use it.
  for (let poll = 0; poll < 5; poll += 1) {
    bridge.getLocalEnvironmentBootstraps();
    bridge.getLocalEnvironmentEnabled();
  }
  const syncCalls = (channel: string) =>
    sendSync.mock.calls.filter(([called]) => called === channel).length;
  expect(syncCalls(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL)).toBeLessThanOrEqual(1);
  expect(syncCalls(IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL)).toBeLessThanOrEqual(1);

  const wsl = {
    id: "wsl:Ubuntu",
    label: "WSL (Ubuntu)",
    runningDistro: "Ubuntu",
    httpBaseUrl: "http://127.0.0.1:4000/",
    wsBaseUrl: "ws://127.0.0.1:4000/",
  };
  vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce([wsl]).mockResolvedValueOnce([]);
  sendSync.mockClear();
  await bridge.refreshLocalEnvironmentBootstraps?.();
  expect(bridge.getLocalEnvironmentBootstraps()).toEqual([wsl]);
  await bridge.refreshLocalEnvironmentBootstraps?.();
  expect(bridge.getLocalEnvironmentBootstraps()).toEqual([]);
  expect(sendSync).not.toHaveBeenCalled();
});
