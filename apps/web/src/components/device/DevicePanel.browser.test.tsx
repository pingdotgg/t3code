import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("~/components/device/DeviceWorkspace", () => ({
  DeviceWorkspace: ({ onPowerOff }: { onPowerOff: () => void }) => (
    <button onClick={onPowerOff}>Power off</button>
  ),
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => children,
}));

const threadA = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
// The panel stays mounted across both kinds of switch.
const switches = [
  ["another thread", { environmentId: threadA.environmentId, threadId: ThreadId.make("thread-2") }],
  [
    "the same thread id in another environment",
    { ...threadA, environmentId: EnvironmentId.make("environment-b") },
  ],
] as const;
const threadB = switches[0][1];
const otherEnvironment = switches[1][1];
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
const streaming: Extract<RightPanelSurface, { kind: "device" }> = {
  id: "device:phone",
  kind: "device",
  target: { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" },
};
const phoneTarget = { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" };
const opened = { _tag: "Success", value: { hostId: "local", deviceId: "phone" } } as const;
const failed = { _tag: "Failure", cause: new Error("boom") } as const;

const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};

let root: Root;
let container: HTMLDivElement;
// Fixed key and a changing threadRef, as RightPanelSurfaceContent mounts it.
const show = (threadRef: ScopedThreadRef, surface = picker) =>
  act(async () =>
    root.render(
      <DevicePanel
        key="device-panel"
        mode="embedded"
        threadRef={threadRef}
        surface={surface}
        visible
        onDismissSetup={() => undefined}
      />,
    ),
  );
const startButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]');
const click = (button: HTMLButtonElement | null) =>
  act(async () => {
    button!.click();
  });
const errors = () => container.querySelectorAll('[role="alert"]');

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DevicePanel thread switches", () => {
  it.each(switches)("does not carry a pending or failed pick to %s", async (_, target) => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await show(threadA);
    await click(startButton());
    expect(startButton()).toBeNull();

    await show(target);
    expect(startButton()?.disabled).toBe(false);

    await act(async () => pick.settle(failed));
    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await show(threadA);
    expect(startButton()?.disabled).toBe(false);
    expect(errors()).toHaveLength(1);

    await show(target);
    expect(startButton()?.disabled).toBe(false);
    expect(errors()).toHaveLength(0);
  });

  it.each([
    [
      "pick",
      picker,
      () => mocks.open,
      () => click(startButton()),
      () => expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(threadA, phoneTarget),
    ],
    [
      "power-off",
      streaming,
      () => mocks.close,
      () => click(container.querySelector("button")),
      () => expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(threadA, streaming.id),
    ],
  ] as const)(
    "applies a late %s to its starting thread after switching environments with the same thread id",
    async (_, surface, command, start, expectApplied) => {
      const late = deferred();
      command().mockReturnValue(late.promise);
      await show(threadA, surface);
      await start();

      await show(otherEnvironment, surface);
      await act(async () => late.settle(opened));

      expectApplied();
    },
  );

  it("keeps a late power-off error in the environment that started it", async () => {
    const powerOff = deferred();
    mocks.close.mockReturnValue(powerOff.promise);
    await show(threadA, streaming);
    await click(container.querySelector("button"));

    await show(otherEnvironment, streaming);
    await act(async () => powerOff.settle(failed));

    expect(errors()).toHaveLength(0);
    expect(mocks.closeSurface).not.toHaveBeenCalled();
    await show(threadA, streaming);
    expect(errors()).toHaveLength(1);
  });

  it("keeps the latest pick pending across switches away and back", async () => {
    const first = deferred();
    const second = deferred();
    const latest = deferred();
    mocks.open
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(latest.promise);
    await show(threadA);
    await click(startButton());
    await show(threadB);
    await click(startButton());
    await show(threadA);
    await click(startButton());

    await act(async () => first.settle(failed));

    expect(startButton()).toBeNull();
    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await act(async () => second.settle(opened));

    expect(startButton()).toBeNull();
    expect(mocks.openDevice.mock.calls).toEqual([[threadB, phoneTarget]]);

    await act(async () => latest.settle(opened));

    expect(startButton()?.disabled).toBe(false);
    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice.mock.calls).toEqual([
      [threadB, phoneTarget],
      [threadA, phoneTarget],
    ]);
  });
});
