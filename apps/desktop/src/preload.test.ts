import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

const { sendSync, invoke, exposed } = vi.hoisted(() => ({
  sendSync: vi.fn(),
  invoke: vi.fn(),
  exposed: {} as Record<string, unknown>,
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: Record<string, unknown>) => {
      for (const key of Object.keys(exposed)) delete exposed[key];
      Object.assign(exposed, bridge);
    },
  },
  ipcRenderer: { sendSync, invoke, on: vi.fn(), removeListener: vi.fn() },
  webFrame: { getZoomFactor: () => 1 },
  webUtils: { getPathForFile: vi.fn() },
}));

vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));

vi.stubGlobal("window", { addEventListener: vi.fn(), localStorage: {} });
vi.stubGlobal("document", {
  addEventListener: vi.fn(),
  fullscreenElement: null,
  documentElement: { style: { setProperty: vi.fn() } },
});

const bootstraps = [
  {
    id: "primary",
    label: "Primary",
    runningDistro: null,
    httpBaseUrl: "http://127.0.0.1:3773/",
    wsBaseUrl: "ws://127.0.0.1:3773/",
  },
];

let refresh: { resolve: (value: unknown) => void } | undefined;
let failingRefreshes = false;

const answerRefresh = (channel: string): Promise<unknown> => {
  if (channel !== IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL) {
    return Promise.resolve(undefined);
  }
  if (failingRefreshes) return Promise.reject(new Error("ipc unavailable"));
  return new Promise((resolve) => {
    refresh = { resolve };
  });
};

// Either topology channel: the cold read moved to its own one, but every call still blocks.
const topologySyncCalls = () =>
  sendSync.mock.calls.filter(([name]) => String(name).includes("local-environment"));

// The refresh only exists when the preload asks for it; the sync path never does.
const resolveRefresh = (value: unknown) => refresh?.resolve(value);

// The refresh resolves through invoke().then().catch().finally(); three turns reach the assignment.
const drainRefresh = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const loadBridge = async () => {
  vi.resetModules();
  sendSync.mockReset();
  invoke.mockReset();
  refresh = undefined;
  failingRefreshes = false;
  sendSync.mockImplementation((channel: string) =>
    String(channel).includes("local-environment-bootstraps") ? [] : null,
  );
  invoke.mockImplementation(answerRefresh);
  await import("./preload.ts");
  return exposed as unknown as DesktopBridge;
};

describe("preload topology snapshots", () => {
  it("answers later reads from the snapshot instead of sendSync", async () => {
    const bridge = await loadBridge();

    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([]);
    expect(topologySyncCalls()).toHaveLength(1);

    resolveRefresh(bootstraps);
    await drainRefresh();

    expect(bridge.getLocalEnvironmentBootstraps()).toEqual(bootstraps);
    expect(topologySyncCalls()).toHaveLength(1);
  });

  it("keeps the last snapshot when a refresh fails", async () => {
    const bridge = await loadBridge();

    bridge.getLocalEnvironmentBootstraps();
    expect(topologySyncCalls()).toHaveLength(1);
    resolveRefresh(bootstraps);
    await drainRefresh();
    failingRefreshes = true;

    expect(bridge.getLocalEnvironmentBootstraps()).toEqual(bootstraps);
    expect(topologySyncCalls()).toHaveLength(1);
  });
});
