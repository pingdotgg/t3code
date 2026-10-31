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
  shutdown: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  list: vi.fn<(request: unknown) => Promise<CommandResult>>(),
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
// One probe per environment, however many views mount it; each probe sends one list.
vi.mock("~/state/device", async () => {
  const Effect = await import("effect/Effect");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    deviceEnvironment: { list: "list", open: "open", close: "close", shutdown: "shutdown" },
    deviceHostProbeAtom: Atom.family((environmentId: string) =>
      Atom.make(() => Effect.promise(() => mocks.list({ environmentId, input: {} }))),
    ),
    NO_DEVICE_PROBE_ATOM: Atom.make(AsyncResult.initial<void, never>()),
    useDeviceState: () => ({ state: currentState, loaded: true }),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "open"
      ? mocks.open
      : command === "close"
        ? mocks.close
        : command === "list"
          ? mocks.list
          : command === "shutdown"
            ? mocks.shutdown
            : () => Promise.resolve({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device failed" }));
vi.mock("~/rightPanelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/rightPanelStore")>()),
  useRightPanelStore: {
    getState: () => ({
      byThreadKey: {},
      openDevice: mocks.openDevice,
      closeSurface: mocks.closeSurface,
    }),
  },
  selectThreadRightPanelState: () => ({ isOpen: false, activeSurfaceId: null, surfaces: [] }),
}));
vi.mock("~/components/device/DeviceHostUpdates", () => ({
  DeviceHostUpdates: () => null,
  hasDeviceHostUpdates: () => false,
}));
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
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
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
  mocks.list.mockResolvedValue({ _tag: "Success", value: { hostId: "local", deviceId: "" } });
  currentState = deviceState;
  container = document.createElement("div");
  container.style.width = "480px";
  container.style.height = "800px";
}

describe("DevicePanel notices", () => {
  it.each(["ios", "android"] as const)(
    "leases a Simlock %s device and returns the opened lease to the pool",
    async (platform) => {
      setup();
      currentState = {
        ...deviceState,
        hosts: [
          {
            id: "pool",
            kind: "simlock",
            label: "Device pool",
            platforms: [
              { platform: "ios", available: true },
              { platform: "android", available: true },
            ],
            hubInstalled: true,
            agentDeviceInstalled: true,
          },
        ],
        hostStatuses: { pool: { status: "ready" } },
        devices: [{ ...phone, hostId: "pool", id: `simlock:${platform}:Phone`, platform }],
        sessions: [],
      };
      mocks.open.mockResolvedValue({
        _tag: "Success",
        value: { hostId: "pool", deviceId: "lease-1" },
      });
      mocks.shutdown.mockResolvedValue({
        _tag: "Success",
        value: { hostId: "pool", deviceId: "lease-1" },
      });
      const readyState = currentState;
      const refused = "The Simlock gateway refused the agent token for Device pool.";
      currentState = {
        ...readyState,
        hosts: readyState.hosts.map((host) => ({
          ...host,
          platforms: host.platforms.map((entry) => ({
            ...entry,
            available: false,
            reason: refused,
          })),
        })),
        devices: [],
      };
      await using screen = await render(devicePanel(threadA), { container });
      expect(container.textContent?.split(refused)).toHaveLength(2);
      const missingPlatform = platform === "ios" ? "Android" : "iOS";
      const emptyPool = `The pool has no ${missingPlatform} devices.`;
      currentState = {
        ...readyState,
        hosts: readyState.hosts.map((host) => ({
          ...host,
          platforms: host.platforms.map((entry) =>
            entry.platform === platform ? entry : { ...entry, available: false, reason: emptyPool },
          ),
        })),
      };
      await screen.rerender(devicePanel(threadA));
      expect(container.textContent).toContain(emptyPool);
      expect(container.textContent).not.toContain(refused);
      currentState = readyState;
      await screen.rerender(devicePanel(threadA));
      expect(container.textContent).not.toContain(emptyPool);
      expect(container.textContent).toContain("Device pool leases devices from a Simlock pool.");
      expect(container.textContent).toContain("Returning a device to the pool wipes it.");
      expect(container.textContent).not.toContain("Xcode");
      expect(container.textContent).not.toContain("Android Studio");
      await click(container.querySelector<HTMLButtonElement>('[aria-label="Lease Phone"]'));
      expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(threadA, {
        hostId: "pool",
        deviceId: "lease-1",
        platform,
        name: "Phone",
      });
      currentState = {
        ...currentState,
        devices: [{ ...phone, hostId: "pool", id: "lease-1", platform, booted: true }],
      };
      await screen.rerender(devicePanel(threadA));
      await click(
        container.querySelector<HTMLButtonElement>('[aria-label="Return to pool Phone"]'),
      );
      expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadA.environmentId,
        input: { hostId: "pool", deviceId: "lease-1", platform },
      });
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );

  it.each(["ios", "android"] as const)("opens an EAS %s cloud session", async (platform) => {
    setup();
    currentState = {
      ...deviceState,
      hosts: [
        {
          id: "expo",
          kind: "eas",
          label: "Expo",
          platforms: (["ios", "android"] as const).map((candidate) => ({
            platform: candidate,
            available: candidate === platform,
            ...(candidate !== platform
              ? { reason: "This platform is temporarily unavailable." }
              : {}),
          })),
          hubInstalled: true,
          agentDeviceInstalled: true,
        },
      ],
      hostStatuses: { expo: { status: "ready" } },
      devices: [{ ...phone, hostId: "expo", id: `eas-${platform}`, platform }],
      sessions: [],
    };
    mocks.open.mockResolvedValue({
      _tag: "Success",
      value: { hostId: "expo", deviceId: "eas-session" },
    });
    await using screen = await render(devicePanel(threadA), { container });
    const devices = platform === "ios" ? "iOS Simulators" : "Android emulators";
    expect(container.textContent).toContain(
      `Expo starts ${devices} in the cloud with EAS Simulator.`,
    );
    expect(container.textContent).toContain("This platform is temporarily unavailable.");
    expect(container.textContent).not.toContain("Xcode");
    expect(container.textContent).not.toContain("Android Studio");
    await click(startButton());
    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(threadA, {
      hostId: "expo",
      deviceId: "eas-session",
      platform,
      name: "Phone",
    });
    currentState = {
      ...currentState,
      hosts: currentState.hosts.map((host) => ({
        ...host,
        platforms: host.platforms.map((entry) => ({ platform: entry.platform, available: true })),
      })),
    };
    await screen.rerender(devicePanel(threadA));
    expect(container.textContent).toContain(
      "Expo starts iOS Simulators and Android emulators in the cloud with EAS Simulator.",
    );
    expect(container.textContent).not.toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("Xcode");
    expect(container.textContent).not.toContain("Android SDK");
    expect(container.textContent).not.toContain("Android Studio");
  });
});

describe("DevicePanel thread switches", () => {
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

describe("DevicePanel host probe", () => {
  it("probes the hosts once while setup shows inside the panel", async () => {
    setup();
    currentState = { ...deviceState, onboardingCompleted: false };
    // An environment no other test probed, so its probe starts fresh.
    const threadRef = { ...threadA, environmentId: EnvironmentId.make("environment-setup") };
    await using _screen = await render(devicePanel(threadRef), { container });

    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(mocks.list.mock.calls).toEqual([
      [{ environmentId: threadRef.environmentId, input: {} }],
    ]);
  });
});
