import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
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
});
