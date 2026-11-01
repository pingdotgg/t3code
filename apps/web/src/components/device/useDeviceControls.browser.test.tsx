import { EnvironmentId, type DeviceDetail, type DeviceSummary } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { AtomCommandConcurrency } from "@t3tools/client-runtime/state/runtime";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/reactivity";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

type Result = { _tag: "Success"; value: DeviceDetail } | { _tag: "Failure"; cause: unknown };
const { read, action, subscribe } = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Result>>(),
  action: vi.fn<() => Promise<Result>>(),
  subscribe:
    vi.fn<(_target: unknown, onChange: (app: { id: string } | null) => void) => () => void>(),
}));
// Stubs only the transport; the device atoms' real scheduler and lanes decide ordering.
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => {
  const runtime = await original();
  const createEnvironmentRpcCommand = (
    _runtime: unknown,
    options: {
      readonly label: string;
      readonly scheduler?: {
        readonly schedule: (
          registry: AtomRegistry.AtomRegistry,
          concurrency: AtomCommandConcurrency<unknown>,
          input: unknown,
          execute: () => Promise<Result>,
        ) => Promise<Result>;
      };
      readonly concurrency?: AtomCommandConcurrency<unknown>;
    },
  ) => {
    const send = options.label === "environment-data:device:detail" ? read : action;
    return {
      label: options.label,
      run: (registry: AtomRegistry.AtomRegistry, input: unknown) =>
        options.scheduler && options.concurrency
          ? options.scheduler.schedule(registry, options.concurrency, input, () => send())
          : send(),
    };
  };
  return { ...runtime, createEnvironmentRpcCommand: createEnvironmentRpcCommand as never };
});
vi.mock(import("./deviceHubApi"), async (original) => ({
  ...(await original()),
  subscribeDeviceForeground: subscribe as never,
}));

import { deviceDetailReadAtom } from "~/state/device";
import { useDeviceControls, type DeviceControls } from "./useDeviceControls";

const offline = Cause.fail(new Error("Device offline"));
const device: DeviceSummary = {
  hostId: "remote",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS",
  booted: true,
  physical: false,
};
const snapshot = (appearance: "light" | "dark"): Result => ({
  _tag: "Success",
  value: {
    hostId: "remote",
    deviceId: "phone",
    settings: { appearance },
    foregroundApp: null,
    readAt: "2026-09-20T00:00:00Z",
  },
});
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let controls: DeviceControls;
const environmentId = EnvironmentId.make("environment");
function Probe({ visible, access = null }: { visible: boolean; access?: DeviceHubAccess | null }) {
  const next = useDeviceControls({ environmentId, device, access, visible });
  useEffect(() => {
    controls = next;
  }, [next]);
  return null;
}
function setup() {
  read.mockReset();
  action.mockReset();
  subscribe.mockReset();
  subscribe.mockReturnValue(() => {});
  read.mockResolvedValue(snapshot("light"));
  // No idle TTL, as in the app: hiding the panel ends its read.
  const registry = AtomRegistry.make();
  const view = (visible: boolean) => (
    <RegistryContext.Provider value={registry}>
      <Probe visible={visible} />
    </RegistryContext.Provider>
  );
  const readAtom = deviceDetailReadAtom({ environmentId, hostId: "remote", deviceId: "phone" });
  const hide = async (screen: { rerender: (element: React.ReactElement) => Promise<unknown> }) => {
    await screen.rerender(view(false));
    await vi.waitFor(() => expect(registry.getNodes().has(readAtom)).toBe(false));
  };
  return { view, hide };
}

it("serializes rapid actions and retains confirmed settings while pending or after failure", async () => {
  const { view } = setup();
  await using _screen = await render(view(true));
  await vi.waitFor(() => expect(controls.detail?.settings.appearance).toBe("light"));
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
    await controls.act({ type: "setAppearance", value: "light" });
  });
  expect(action).toHaveBeenCalledOnce();
  expect(controls.disabled).toBe(true);
  expect(controls.detail?.settings.appearance).toBe("light");
  await act(async () => {
    response.resolve(snapshot("dark"));
    await pending;
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
  action.mockResolvedValueOnce({ _tag: "Failure", cause: offline });
  await act(async () => controls.act({ type: "setAppearance", value: "light" }));
  expect(controls.detail?.settings.appearance).toBe("dark");
  expect(controls.error).toBe("Device offline");
  expect(controls.disabled).toBe(false);
});

it("confirms settings again after a command sent before the panel reopened", async () => {
  const { view, hide } = setup();
  await using screen = await render(view(true));
  await vi.waitFor(() => expect(controls.detail).not.toBeNull());
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
  });
  await hide(screen);
  read.mockResolvedValueOnce({ _tag: "Failure", cause: offline });
  await screen.rerender(view(true));
  await act(async () => {
    response.resolve(snapshot("dark"));
    await pending;
  });
  await vi.waitFor(() => expect(controls.error).toBe("Device offline"));
  expect(controls.detail).toBeNull();
  expect(controls.disabled).toBe(true);
  await act(async () => controls.act({ type: "setAppearance", value: "light" }));
  expect(action).toHaveBeenCalledOnce();
  await hide(screen);
  await screen.rerender(view(true));
  await vi.waitFor(() => expect(controls.disabled).toBe(false));
  expect(controls.error).toBeNull();
});

it("does not let a read sent before an action overwrite the action's answer", async () => {
  const { view, hide } = setup();
  await using screen = await render(view(true));
  await vi.waitFor(() => expect(controls.detail).not.toBeNull());
  await hide(screen);
  const refresh = deferred();
  read.mockReturnValueOnce(refresh.promise);
  await screen.rerender(view(true));
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  action.mockResolvedValueOnce(snapshot("dark"));
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
  });
  await act(async () => {
    refresh.resolve(snapshot("light"));
    await pending;
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
});
