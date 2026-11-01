import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useEffect } from "react";

import { act, render } from "../../test/render";
import { DevicePanel } from "../components/device/DevicePanel";
import {
  startAgentOpenedPreviews,
  resetDeviceSessionBaselinesForTests,
} from "../components/preview/agentOpenedPreviews";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { deviceEnvironment, useDeviceState } from "./device";

vi.mock(import("./presentation"), async (original) => ({
  ...(await original()),
  environmentSummaries: {
    ...(await original()).environmentSummaries,
    connectedEnvironmentIdsAtom: Atom.make([EnvironmentId.make("device-loading")]),
  },
}));
vi.mock(import("../hooks/useSettings"), () => ({
  getClientSettings: (() => ({ browserAutoShowFloatingPreview: true })) as never,
  useClientSettings: ((
    select: (settings: { browserAutoShowFloatingPreview: boolean }) => unknown,
  ) => select({ browserAutoShowFloatingPreview: true })) as never,
}));
vi.mock(import("./use-atom-command"), () => {
  const run = () => Promise.resolve({ _tag: "Success", value: {} });
  return { useAtomCommand: (() => run) as never };
});
vi.mock(import("../components/device/DeviceHostUpdates"), () => ({
  DeviceHostUpdates: () => null,
}));

it("baselines the first device snapshot without reopening dismissed devices", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const threadRef = {
    environmentId: EnvironmentId.make("device-loading"),
    threadId: ThreadId.make("thread"),
  };
  const threadKey = scopedThreadKey(threadRef);
  const snapshot: DeviceServiceState = {
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [
      {
        hostId: "local",
        id: "phone",
        platform: "ios",
        name: "Phone",
        version: "26",
        booted: true,
        physical: false,
      },
    ],
    sessions: [
      {
        threadId: threadRef.threadId,
        hostId: "local",
        deviceId: "phone",
        platform: "ios",
        openedAt: "2026-10-01T00:00:00Z",
      },
    ],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };
  const registry = appAtomRegistry;
  resetDeviceSessionBaselinesForTests();
  using _baselines = { [Symbol.dispose]: resetDeviceSessionBaselinesForTests };
  const stateAtom = Atom.make<AsyncResult.AsyncResult<DeviceServiceState>>(AsyncResult.initial());
  using _subscription = vi.spyOn(deviceEnvironment, "state").mockReturnValue(stateAtom);
  using _store = {
    [Symbol.dispose]: () => usePreviewMiniPlayerStore.getState().removeThread(threadRef),
  };
  using _following = { [Symbol.dispose]: startAgentOpenedPreviews() };
  let loaded = false;
  function Probe() {
    const device = useDeviceState(threadRef.environmentId);
    useEffect(() => {
      loaded = device.loaded;
    }, [device.loaded]);
    return null;
  }
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  const initiallyLoaded = loaded;
  await act(() => registry.set(stateAtom, AsyncResult.success(snapshot)));
  expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]).toBeUndefined();
  expect(initiallyLoaded).toBe(false);
  expect(loaded).toBe(true);

  await act(() => registry.set(stateAtom, AsyncResult.waiting(AsyncResult.success(snapshot))));
  expect(loaded).toBe(true);

  const nextDevice = { ...snapshot.devices[0]!, id: "tablet", name: "Tablet" };
  await act(() =>
    registry.set(
      stateAtom,
      AsyncResult.success({
        ...snapshot,
        devices: [...snapshot.devices, nextDevice],
        sessions: [...snapshot.sessions, { ...snapshot.sessions[0]!, deviceId: nextDevice.id }],
        revision: 2,
      }),
    ),
  );
  expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source).toEqual({
    kind: "device",
    hostId: "local",
    deviceId: "tablet",
    platform: "ios",
    name: "Tablet",
  });
});

it("reports a failed first device load and retries it", async () => {
  let attempts = 0;
  const stateAtom = Atom.make(
    (): AsyncResult.AsyncResult<DeviceServiceState, EnvironmentAuthorizationError> => {
      attempts += 1;
      return attempts === 1
        ? AsyncResult.fail(
            new EnvironmentAuthorizationError({
              requiredScope: "orchestration:read",
              message: "Device access denied",
            }),
          )
        : AsyncResult.success({
            hosts: [],
            hostStatus: "ready",
            hostStatuses: {},
            devices: [],
            sessions: [],
            onboardingCompleted: true,
            agentAccessEnabled: false,
            hubBasePath: "/api/device-hub",
            revision: 1,
          });
    },
  ).pipe(Atom.keepAlive);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using _subscription = vi.spyOn(deviceEnvironment, "state").mockReturnValue(stateAtom);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <DevicePanel
        mode="embedded"
        threadRef={{
          environmentId: EnvironmentId.make("device-load-failure"),
          threadId: ThreadId.make("thread"),
        }}
        surface={{ id: "device", kind: "device" }}
        visible
        onDismissSetup={() => undefined}
      />
    </RegistryContext.Provider>,
  );

  await expect.element(screen.getByRole("alert").getByText("Device access denied")).toBeVisible();

  await screen.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByRole("button", { name: "Refresh devices" })).toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});
