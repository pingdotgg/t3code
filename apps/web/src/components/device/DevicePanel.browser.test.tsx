import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { act, render } from "../../../test/render";

import { DevicePanel } from "./DevicePanel";
import "~/index.css";

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
let currentState = deviceState;
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", open: "open", close: "close" },
  useDeviceState: () => ({ state: currentState, loaded: true }),
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
vi.mock("~/components/device/DeviceWorkspace", () => ({
  DeviceWorkspace: ({ onPowerOff }: { onPowerOff: () => void }) => (
    <button onClick={onPowerOff}>Power off</button>
  ),
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => (
    <div className="flex h-full min-h-0 flex-col">{children}</div>
  ),
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

let container: HTMLDivElement;
// Fixed key and a changing threadRef, as RightPanelSurfaceContent mounts it.
const devicePanel = (threadRef: ScopedThreadRef, surface = picker) => (
  <DevicePanel
    key="device-panel"
    mode="embedded"
    threadRef={threadRef}
    surface={surface}
    visible
    onDismissSetup={() => undefined}
  />
);
const startButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]');
const click = (button: HTMLButtonElement | null) =>
  act(async () => {
    button!.click();
  });
const errors = () => container.querySelectorAll('[role="alert"]');

function setup() {
  vi.resetAllMocks();
  currentState = deviceState;
  container = document.createElement("div");
  container.style.width = "480px";
  container.style.height = "800px";
}

describe("DevicePanel notices", () => {
  it("keeps discovery warnings dismissed until the diagnostic or environment changes", async () => {
    setup();
    currentState = {
      ...deviceState,
      hostStatusDetail: "Could not read simulator usage timestamps.",
    };
    await using screen = await render(devicePanel(threadA), { container });
    expect(errors()).toHaveLength(1);
    expect(startButton()?.disabled).toBe(false);
    await click(container.querySelector('[aria-label="Dismiss device warning"]'));
    expect(errors()).toHaveLength(0);
    await screen.rerender(devicePanel(threadA));
    expect(errors()).toHaveLength(0);

    currentState = { ...currentState, hostStatusDetail: "A different discovery warning." };
    await screen.rerender(devicePanel(threadA));
    expect(errors()).toHaveLength(1);
    await click(container.querySelector('[aria-label="Dismiss device warning"]'));
    await screen.rerender(devicePanel(otherEnvironment));
    expect(errors()).toHaveLength(1);
  });

  it("keeps the loading content centered when discovery and boot notices arrive or are dismissed", async () => {
    setup();
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await using screen = await render(devicePanel(threadA), { container });
    await click(startButton());
    const loadingBounds = () =>
      container
        .querySelector('[aria-label="Step 1 of 2: open device"]')!
        .parentElement!.getBoundingClientRect();
    const before = loadingBounds();
    const panel = container.getBoundingClientRect();
    expect(before.height).toBeGreaterThan(0);
    expect(before.top + before.height / 2).toBeCloseTo(panel.top + panel.height / 2, 0);

    currentState = {
      ...deviceState,
      hostStatusDetail: "Could not read CoreSimulator plist.\n".repeat(8),
      bootingDevices: [{ ...phone, threadId: threadA.threadId }],
    };
    await screen.rerender(devicePanel(threadA));
    expect(loadingBounds().top).toBe(before.top);
    expect(loadingBounds().left).toBe(before.left);
    await click(container.querySelector('[aria-label="Dismiss device warning"]'));
    expect(loadingBounds().top).toBe(before.top);
    expect(loadingBounds().left).toBe(before.left);
    await act(async () => pick.settle(failed));
  });
});

describe("DevicePanel thread switches", () => {
  it.each(switches)("does not carry a pending or failed pick to %s", async (_, target) => {
    setup();
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await using screen = await render(devicePanel(threadA), { container });
    await click(startButton());
    expect(startButton()).toBeNull();

    await screen.rerender(devicePanel(target));
    expect(startButton()?.disabled).toBe(false);

    await act(async () => pick.settle(failed));
    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await screen.rerender(devicePanel(threadA));
    expect(startButton()?.disabled).toBe(false);
    expect(errors()).toHaveLength(1);

    await screen.rerender(devicePanel(target));
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
      setup();
      const late = deferred();
      command().mockReturnValue(late.promise);
      await using screen = await render(devicePanel(threadA, surface), { container });
      await start();

      await screen.rerender(devicePanel(otherEnvironment, surface));
      await act(async () => late.settle(opened));

      expectApplied();
    },
  );

  it("keeps a late power-off error in the environment that started it", async () => {
    setup();
    const powerOff = deferred();
    mocks.close.mockReturnValue(powerOff.promise);
    await using screen = await render(devicePanel(threadA, streaming), { container });
    await click(container.querySelector("button"));

    await screen.rerender(devicePanel(otherEnvironment, streaming));
    await act(async () => powerOff.settle(failed));

    expect(errors()).toHaveLength(0);
    expect(mocks.closeSurface).not.toHaveBeenCalled();
    await screen.rerender(devicePanel(threadA, streaming));
    expect(errors()).toHaveLength(1);
  });

  it("keeps the latest pick pending across switches away and back", async () => {
    setup();
    const first = deferred();
    const second = deferred();
    const latest = deferred();
    mocks.open
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(latest.promise);
    await using screen = await render(devicePanel(threadA), { container });
    await click(startButton());
    await screen.rerender(devicePanel(threadB));
    await click(startButton());
    await screen.rerender(devicePanel(threadA));
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
