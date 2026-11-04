import { act, render as renderScreen, type Screen } from "../../../test/render";
import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext } from "../panelHost";

type CommandResult =
  | { _tag: "Success"; value: { hostId: string; deviceId: string } }
  | { _tag: "Failure"; cause: unknown };
const mocks = vi.hoisted(() => ({
  open: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  close: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  openDevice: vi.fn(),
  closeSurface: vi.fn(),
}));
const phone = {
  hostId: "local",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS 19",
  booted: false,
  physical: false,
} as const;
const deviceState: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [phone],
  sessions: [
    {
      threadId: ThreadId.make("thread-1"),
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
vi.mock("~/state/device", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  return {
    deviceHostProbeAtom: Atom.family(() => Atom.make(Effect.void)),
    NO_DEVICE_PROBE_ATOM: Atom.make(AsyncResult.initial()),
    deviceEnvironment: { list: "list", open: "open", close: "close" },
    useDeviceState: () => ({ state: deviceState, loaded: true }),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "open"
      ? mocks.open
      : command === "close"
        ? mocks.close
        : () => Promise.resolve({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device failed" }));
vi.mock("~/rightPanelStore", () => ({
  selectThreadRightPanelState: () => ({ activeSurfaceId: null }),
  useRightPanelStore: {
    getState: () => ({ openDevice: mocks.openDevice, closeSurface: mocks.closeSurface }),
  },
}));
vi.mock("~/components/device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("~/components/device/DeviceLoadingView", () => ({
  DeviceLoadingView: ({ name, message }: { name: string; message: string }) => (
    <div role="status" aria-label={`Opening ${name}`}>
      {message}
    </div>
  ),
}));
vi.mock("~/components/device/DeviceWorkspace", () => ({
  DeviceWorkspace: ({ onPowerOff }: { onPowerOff: () => void }) => (
    <button onClick={onPowerOff}>Power off</button>
  ),
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => children,
}));

// Same thread id in another environment: the surface id collides, so the panel
// stays mounted across the switch, as it does under ChatView's surface key.
const picking = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
const next = { environmentId: EnvironmentId.make("environment-b"), threadId: picking.threadId };
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
const streaming: Extract<RightPanelSurface, { kind: "device" }> = {
  id: "device:phone",
  kind: "device",
  target: { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" },
};

// Mounted the way ChatView mounts it: through the registry, lazily, on the panel host.
const render = (threadRef: ScopedThreadRef, surface = picker) => (
  <PanelHostContext
    value={{
      threadRef,
      visible: true,
      composerDraftTarget: threadRef,
      workspaceMutationId: null,
      sendAnnotation: () => undefined,
    }}
  >
    <RegisteredSidePanel
      key={surface.id}
      id="device"
      surface={surface}
      onDismissSetup={() => undefined}
    />
  </PanelHostContext>
);
const mount = async (screen: Screen, threadRef: ScopedThreadRef, surface = picker) => {
  await screen.rerender(render(threadRef, surface));
  // Wait for the registered lazy body to load and replace the Suspense fallback.
  await act(async () => {
    await import("./DeviceSidePanel");
  });
};
const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};
const startPhone = (screen: Screen) =>
  act(async () => {
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.click();
  });
const errors = (screen: Screen) => screen.container.querySelectorAll('[role="alert"]');
const opened = { _tag: "Success", value: { hostId: "local", deviceId: "phone" } } as const;

describe("registered Device panel", () => {
  it("opens a picked device when the pick settles in the same thread", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await mount(screen, picking);

    await startPhone(screen);
    expect(mocks.open).toHaveBeenCalledWith({
      environmentId: picking.environmentId,
      input: { threadId: picking.threadId, hostId: "local", deviceId: "phone", platform: "ios" },
    });
    await act(async () => pick.settle(opened));

    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(picking, {
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      name: "Phone",
    });
  });

  it("keeps the next thread's picker usable while an earlier pick is pending", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    mocks.open.mockReturnValue(deferred().promise);
    await mount(screen, picking);

    await startPhone(screen);
    await screen.rerender(render(next));

    expect(
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.disabled,
    ).toBe(false);
  });

  it("opens a pick that settles after a switch in the thread it started in", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await mount(screen, picking);

    await startPhone(screen);
    await screen.rerender(render(next));
    await act(async () => pick.settle(opened));

    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(picking, {
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      name: "Phone",
    });
    expect(
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.disabled,
    ).toBe(false);
  });

  it("shows a late failed pick when returning to its starting scope", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await mount(screen, picking);

    await startPhone(screen);
    await screen.rerender(render(next));
    await screen.rerender(render(picking));
    expect(screen.container.querySelector('[aria-label="Start Phone"]')).toBeNull();
    expect(
      screen.container.querySelector('[role="status"][aria-label="Opening Phone"]')?.textContent,
    ).toBe("Starting device…");
    expect(errors(screen)).toHaveLength(0);
    await act(async () => pick.settle({ _tag: "Failure", cause: new Error("boom") }));

    expect(errors(screen)).toHaveLength(1);
    expect(errors(screen)[0]?.textContent).toContain("Device failed");
    expect(
      screen.container.querySelector('[role="status"][aria-label="Opening Phone"]'),
    ).toBeNull();
    expect(
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.disabled,
    ).toBe(false);
    expect(mocks.openDevice).not.toHaveBeenCalled();
  });

  it("does not carry an operation error into another thread", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    mocks.open.mockResolvedValue({ _tag: "Failure", cause: new Error("boom") });
    await mount(screen, picking);

    await startPhone(screen);
    expect(errors(screen)).toHaveLength(1);
    await screen.rerender(render(next));

    expect(errors(screen)).toHaveLength(0);
  });

  it("closes a powered-off surface in its own thread after the panel moved", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    const powerOff = deferred();
    mocks.close.mockReturnValue(powerOff.promise);
    await mount(screen, picking, streaming);

    await act(async () => {
      screen.container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(mocks.close).toHaveBeenCalledWith({
      environmentId: picking.environmentId,
      input: { threadId: picking.threadId, hostId: "local", deviceId: "phone", shutdown: true },
    });
    await screen.rerender(render(next, streaming));
    await act(async () => powerOff.settle(opened));

    expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(picking, streaming.id);
  });

  it("closes the surface when a power-off settles in the same thread", async () => {
    resetFixture();
    await using screen = await renderScreen(null, { router: false });
    mocks.close.mockResolvedValue(opened);
    await mount(screen, picking, streaming);

    await act(async () => {
      screen.container.querySelector<HTMLButtonElement>("button")!.click();
    });

    expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(picking, streaming.id);
  });
});

function resetFixture() {
  vi.clearAllMocks();
}
