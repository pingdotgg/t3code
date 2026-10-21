import { it } from "@effect/vitest";
import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect } from "vite-plus/test";

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
  it.effect.each([
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
  ])("retains the $expectedTag cause", (testCase) =>
    Effect.gen(function* () {
      const atom = createDesktopNetworkAccessStateAtom(() => ({
        getAdvertisedEndpoints: testCase.getAdvertisedEndpoints,
        getServerExposureState: testCase.getServerExposureState,
      }));
      const registry = AtomRegistry.make();
      registry.mount(atom);

      yield* Effect.exit(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));
      const result = registry.get(atom);
      if (!AsyncResult.isFailure(result)) throw new Error("Expected network access load to fail.");

      expect(Cause.squash(result.cause)).toEqual(
        expect.objectContaining({
          _tag: testCase.expectedTag,
          cause: testCase.cause,
        }),
      );
      registry.dispose();
    }),
  );
});
