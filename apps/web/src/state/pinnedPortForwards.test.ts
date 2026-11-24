import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import type { DesktopPreviewBridge } from "@t3tools/contracts";
import type { ClientSettings, PinnedPortForward } from "@t3tools/contracts/settings";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  pinnedPortForwardsAtom,
  retryPinnedPortForward,
  startPinnedPortForwards,
  unpinPortForward,
} from "./pinnedPortForwards";

const presentation = Atom.make({
  connection: { phase: "offline" },
  entry: { enabled: true },
  serverConfig: true,
});
const session = Atom.make(AsyncResult.success(true));
const pin: PinnedPortForward = {
  environmentId: EnvironmentId.make("remote"),
  remotePort: 59347,
  label: "Portless",
};

const fixture: { settings: ClientSettings | null; listeners: Set<() => void> } = vi.hoisted(() => ({
  settings: null,
  listeners: new Set<() => void>(),
}));

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => fixture.settings,
  persistClientSettingsUpdate: async (update: (settings: ClientSettings) => ClientSettings) => {
    if (!fixture.settings) throw new Error("Missing initial settings.");
    fixture.settings = update(fixture.settings);
    fixture.listeners.forEach((listener) => listener());
    return fixture.settings;
  },
  subscribeClientSettings: (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  },
}));

vi.mock("./presentation", () => ({
  environmentPresentations: { presentationAtom: () => presentation },
}));

vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => session },
  sessionHasScope: (result: AsyncResult.Success<boolean>) => result.value,
}));

vi.mock("./portForwards", () => ({
  canForwardPorts: () => true,
  previewBridge: () => window.desktopBridge?.preview,
}));

it("restores a saved pin only while connected with terminal access, and forgets it when stopped", async () => {
  vi.useFakeTimers();
  fixture.settings = { ...DEFAULT_CLIENT_SETTINGS, pinnedPortForwards: [pin] };
  let boundOwner: string | undefined;
  let occupied = true;
  const status = () => appAtomRegistry.get(pinnedPortForwardsAtom)[0]?.status;
  const forwardPort: DesktopPreviewBridge["forwardPort"] = async (
    environmentId,
    remotePort,
    options,
  ) => {
    if (!options?.pinned || !options.owner) throw new Error("Expected an owned pinned listener.");
    if (occupied) throw new Error("LoopbackTunnelPortInUseError: Local port is already in use.");
    boundOwner = options.owner;
    return { environmentId, remotePort, localPort: remotePort, pinned: true };
  };
  const stopPortForward: DesktopPreviewBridge["stopPortForward"] = async (_, __, owner) => {
    if (owner === boundOwner) boundOwner = undefined;
  };
  vi.stubGlobal("window", { desktopBridge: { preview: { forwardPort, stopPortForward } } });
  const stop = startPinnedPortForwards();
  try {
    await vi.runAllTimersAsync();
    expect(status()).toBe("waiting");

    appAtomRegistry.set(presentation, {
      ...appAtomRegistry.get(presentation),
      connection: { phase: "connected" },
    });
    await vi.runAllTimersAsync();
    expect(status()).toBe("port-in-use");
    expect(boundOwner).toBeUndefined();

    occupied = false;
    retryPinnedPortForward(pin.environmentId, pin.remotePort);
    await vi.runAllTimersAsync();
    expect(status()).toBe("forwarded");
    const firstOwner = boundOwner;
    expect(firstOwner).toBeDefined();

    appAtomRegistry.set(session, AsyncResult.success(false));
    await vi.runAllTimersAsync();
    expect(status()).toBe("access-required");
    expect(boundOwner).toBeUndefined();
    expect(fixture.settings.pinnedPortForwards).toEqual([pin]);

    appAtomRegistry.set(session, AsyncResult.success(true));
    await vi.runAllTimersAsync();
    expect(boundOwner).toBeDefined();
    expect(boundOwner).not.toBe(firstOwner);

    await unpinPortForward(pin.environmentId, pin.remotePort);
    await vi.runAllTimersAsync();
    expect(boundOwner).toBeUndefined();
    expect(fixture.settings.pinnedPortForwards).toEqual([]);
  } finally {
    stop();
    appAtomRegistry.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
