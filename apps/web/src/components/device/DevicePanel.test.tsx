import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { DevicePanel } from "./DevicePanel";

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
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", open: "open", close: "close" },
  useDeviceState: () => ({ state: deviceState, loaded: true }),
}));
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
  useRightPanelStore: {
    getState: () => ({ openDevice: mocks.openDevice, closeSurface: mocks.closeSurface }),
  },
}));
vi.mock("~/components/device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("~/components/device/DeviceLoadingView", () => ({ DeviceLoadingView: () => null }));
vi.mock("~/components/device/DeviceWorkspace", () => ({ DeviceWorkspace: () => null }));
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
// Another thread in the same environment, as when ChatView keeps the panel for a shared surface.
const sibling = { environmentId: picking.environmentId, threadId: ThreadId.make("thread-2") };
const switches = [
  ["the same thread id in another environment", next],
  ["another thread in the same environment", sibling],
] as const;
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
const streaming: Extract<RightPanelSurface, { kind: "device" }> = {
  id: "device:phone",
  kind: "device",
  target: { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" },
};

const render = (threadRef: ScopedThreadRef, surface = picker) => (
  <DevicePanel
    key={surface.id}
    mode="embedded"
    threadRef={threadRef}
    surface={surface}
    visible
    onDismissSetup={() => undefined}
  />
);
const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};
const startPhone = (renderer: ReactTestRenderer) =>
  act(async () => {
    renderer.root.findByProps({ "aria-label": "Start Phone" }).props.onClick();
  });
const errors = (renderer: ReactTestRenderer) => renderer.root.findAllByProps({ role: "alert" });
const startButtons = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByProps({ "aria-label": "Start Phone" });
const pressPowerOff = (renderer: ReactTestRenderer) =>
  act(async () => {
    renderer.root.findByProps({ hostLabel: "This Mac" }).props.onPowerOff();
  });
const opened = { _tag: "Success", value: { hostId: "local", deviceId: "phone" } } as const;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("DevicePanel", () => {
  it("opens a picked device when the pick settles in the same thread", async () => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    const renderer = await act(async () => create(render(picking)));

    await startPhone(renderer);
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

  it.each(switches)(
    "keeps the picker usable after switching to %s while a pick is pending",
    async (_, target) => {
      mocks.open.mockReturnValue(deferred().promise);
      const renderer = await act(async () => create(render(picking)));

      await startPhone(renderer);
      await act(async () => renderer.update(render(target)));

      expect(renderer.root.findByProps({ "aria-label": "Start Phone" }).props.disabled).toBe(false);
    },
  );

  it("keeps the next thread's own pick pending when an earlier pick settles", async () => {
    const first = deferred();
    const second = deferred();
    mocks.open.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const renderer = await act(async () => create(render(picking)));

    await startPhone(renderer);
    await act(async () => renderer.update(render(sibling)));
    await startPhone(renderer);
    await act(async () => first.settle(opened));

    expect(startButtons(renderer)).toHaveLength(0);
    await act(async () => second.settle(opened));
    expect(startButtons(renderer).length).toBeGreaterThan(0);
    expect(mocks.openDevice.mock.calls.map(([threadRef]) => threadRef)).toEqual([picking, sibling]);
  });

  it("opens a pick that settles after a switch in the thread it started in", async () => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    const renderer = await act(async () => create(render(picking)));

    await startPhone(renderer);
    await act(async () => renderer.update(render(next)));
    await act(async () => pick.settle(opened));

    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(picking, {
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      name: "Phone",
    });
    expect(renderer.root.findByProps({ "aria-label": "Start Phone" }).props.disabled).toBe(false);
  });

  it.each(switches)(
    "hides a failed pick that settles after switching to %s and back",
    async (_, target) => {
      const pick = deferred();
      mocks.open.mockReturnValue(pick.promise);
      const renderer = await act(async () => create(render(picking)));

      await startPhone(renderer);
      await act(async () => renderer.update(render(target)));
      await act(async () => renderer.update(render(picking)));
      await act(async () => pick.settle({ _tag: "Failure", cause: new Error("boom") }));

      expect(errors(renderer)).toHaveLength(0);
      expect(mocks.openDevice).not.toHaveBeenCalled();
    },
  );

  it.each(switches)("does not carry an operation error to %s", async (_, target) => {
    mocks.open.mockResolvedValue({ _tag: "Failure", cause: new Error("boom") });
    const renderer = await act(async () => create(render(picking)));

    await startPhone(renderer);
    expect(errors(renderer)).toHaveLength(1);
    await act(async () => renderer.update(render(target)));

    expect(errors(renderer)).toHaveLength(0);
  });

  it("closes a powered-off surface in its own thread after the panel moved", async () => {
    const powerOff = deferred();
    mocks.close.mockReturnValue(powerOff.promise);
    const renderer = await act(async () => create(render(picking, streaming)));

    await pressPowerOff(renderer);
    expect(mocks.close).toHaveBeenCalledWith({
      environmentId: picking.environmentId,
      input: { threadId: picking.threadId, hostId: "local", deviceId: "phone", shutdown: true },
    });
    await act(async () => renderer.update(render(next, streaming)));
    await act(async () => powerOff.settle(opened));

    expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(picking, streaming.id);
  });

  it("shows a failed power-off only in the thread that started it", async () => {
    const late = deferred();
    mocks.close
      .mockResolvedValueOnce({ _tag: "Failure", cause: new Error("boom") })
      .mockReturnValueOnce(late.promise);
    const renderer = await act(async () => create(render(picking, streaming)));

    await pressPowerOff(renderer);
    expect(errors(renderer)).toHaveLength(1);

    await pressPowerOff(renderer);
    await act(async () => renderer.update(render(sibling, streaming)));
    await act(async () => late.settle({ _tag: "Failure", cause: new Error("boom") }));

    expect(errors(renderer)).toHaveLength(0);
    expect(mocks.closeSurface).not.toHaveBeenCalled();
  });
});
