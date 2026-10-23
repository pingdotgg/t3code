import { EnvironmentId, type DeviceDetail, type DeviceSummary } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import * as Cause from "effect/Cause";
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
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { deviceEnvironment } = await import("~/state/device");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === deviceEnvironment.detail ? read : action) as never,
  };
});
vi.mock(import("./deviceHubApi"), async (original) => ({
  ...(await original()),
  subscribeDeviceForeground: subscribe as never,
}));

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
function Probe({ visible, access = null }: { visible: boolean; access?: DeviceHubAccess | null }) {
  const next = useDeviceControls({
    environmentId: EnvironmentId.make("environment"),
    device,
    access,
    visible,
  });
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
}

it("serializes rapid actions and retains confirmed settings while pending or after failure", async () => {
  setup();
  await using _screen = await render(<Probe visible />);
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

it("keeps actions disabled when settings cannot be confirmed after a detached command", async () => {
  setup();
  await using screen = await render(<Probe visible />);
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
  });
  await screen.rerender(<Probe visible={false} />);
  await screen.rerender(<Probe visible />);
  read.mockResolvedValueOnce({ _tag: "Failure", cause: offline });
  await act(async () => {
    response.resolve(snapshot("dark"));
    await pending;
  });
  expect(controls.detail).toBeNull();
  expect(controls.disabled).toBe(true);
  expect(controls.error).toBe("Device offline");
  await act(async () => controls.act({ type: "setAppearance", value: "light" }));
  expect(action).toHaveBeenCalledOnce();
  await screen.rerender(<Probe visible={false} />);
  await screen.rerender(<Probe visible />);
  expect(controls.disabled).toBe(false);
  expect(controls.error).toBeNull();
});

it("does not let an older refresh overwrite a newer confirmed action", async () => {
  setup();
  await using screen = await render(<Probe visible />);
  await screen.rerender(<Probe visible={false} />);
  const refresh = deferred();
  read.mockReturnValueOnce(refresh.promise);
  await screen.rerender(<Probe visible />);
  action.mockResolvedValueOnce(snapshot("dark"));
  await act(async () => controls.act({ type: "setAppearance", value: "dark" }));
  await act(async () => {
    refresh.resolve(snapshot("light"));
    await refresh.promise;
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
});
