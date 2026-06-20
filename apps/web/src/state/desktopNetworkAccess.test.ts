import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopNetworkAccessStateAtom } from "./desktopNetworkAccess";

const serverExposureState: DesktopServerExposureState = {
  advertisedHost: "192.168.1.10",
  endpointUrl: "http://192.168.1.10:37737",
  mode: "network-accessible",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

const advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint> = [];
const serverExposureLoadCause = new Error("exposure failed");
const advertisedEndpointsLoadCause = new Error("endpoints failed");

describe("desktopNetworkAccessState", () => {
  it("retains the loaded snapshot when the settings screen remounts", async () => {
    const getServerExposureState = vi.fn(async () => serverExposureState);
    const getAdvertisedEndpoints = vi.fn(async () => advertisedEndpoints);
    const atom = createDesktopNetworkAccessStateAtom(() => ({
      getAdvertisedEndpoints,
      getServerExposureState,
    }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some" }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    const result = registry.get(atom);
    expect(AsyncResult.value(result)).toEqual(
      expect.objectContaining({
        _tag: "Some",
        value: { advertisedEndpoints, serverExposureState },
      }),
    );
    expect(getServerExposureState).toHaveBeenCalledTimes(1);
    expect(getAdvertisedEndpoints).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it.each([
    {
      cause: serverExposureLoadCause,
      expectedTag: "DesktopServerExposureStateLoadError",
      getAdvertisedEndpoints: async () => advertisedEndpoints,
      getServerExposureState: async () => Promise.reject(serverExposureLoadCause),
    },
    {
      cause: advertisedEndpointsLoadCause,
      expectedTag: "DesktopAdvertisedEndpointsLoadError",
      getAdvertisedEndpoints: async () => Promise.reject(advertisedEndpointsLoadCause),
      getServerExposureState: async () => serverExposureState,
    },
  ])("retains the $expectedTag cause", async (testCase) => {
    const atom = createDesktopNetworkAccessStateAtom(() => ({
      getAdvertisedEndpoints: testCase.getAdvertisedEndpoints,
      getServerExposureState: testCase.getServerExposureState,
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected network access load to fail.");

    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({
        _tag: testCase.expectedTag,
        cause: testCase.cause,
      }),
    );
    registry.dispose();
  });
});
