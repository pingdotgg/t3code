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
    invoke: vi.fn(async (channel: string) =>
      channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL ? true : [],
    ),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: () => "" },
}));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));

it("polling topology reads do not block the renderer on synchronous IPC each time", async () => {
  vi.stubGlobal("window", {
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  await import("./preload.ts");
  const bridge = exposed.get("desktopBridge") as DesktopBridge;
  sendSync.mockClear();

  // The renderer's platform poll reads these every few seconds; ipcRenderer.sendSync
  // freezes the renderer for as long as the main process takes to answer.
  for (let poll = 0; poll < 5; poll += 1) {
    bridge.getLocalEnvironmentBootstraps();
    bridge.getLocalEnvironmentEnabled?.();
  }

  const syncCalls = (channel: string) =>
    sendSync.mock.calls.filter(([called]) => called === channel).length;
  // Each read may block once at startup; later polls must not.
  expect
    .soft(syncCalls(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL))
    .toBeLessThanOrEqual(1);
  expect.soft(syncCalls(IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL)).toBeLessThanOrEqual(1);
});

it("an async topology refresh replaces the bootstraps later reads return", async () => {
  vi.stubGlobal("window", {
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  await import("./preload.ts");
  const bridge = exposed.get("desktopBridge") as DesktopBridge;
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
