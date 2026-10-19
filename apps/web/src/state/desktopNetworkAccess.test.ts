import { it } from "@effect/vitest";
import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, vi } from "vite-plus/test";

import { createDesktopNetworkAccessStateAtom } from "./desktopNetworkAccess";

const serverExposureState: DesktopServerExposureState = {
  advertisedHost: "192.168.1.10",
  endpointUrl: "http://192.168.1.10:37737",
  mode: "network-accessible",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

const advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint> = [];
const tailscaleEndpoint: AdvertisedEndpoint = {
  id: "tailscale-ip:100.74.126.34",
  httpBaseUrl: "http://100.74.126.34:37737/",
  wsBaseUrl: "ws://100.74.126.34:37737/",
  label: "Tailscale IP",
  provider: { id: "tailscale", kind: "private-network", label: "Tailscale", isAddon: true },
  reachability: "private-network",
  status: "available",
  source: "desktop-addon",
  compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
};
const serverExposureLoadCause = new Error("exposure failed");
const advertisedEndpointsLoadCause = new Error("endpoints failed");

describe("desktopNetworkAccessState", () => {
  it.effect("retains a fresh snapshot after the settings screen unmounts and remounts", () =>
    Effect.gen(function* () {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const getServerExposureState = vi.fn(async () => serverExposureState);
      const getAdvertisedEndpoints = vi.fn(async () => advertisedEndpoints);
      const atom = createDesktopNetworkAccessStateAtom(() => ({
        getAdvertisedEndpoints,
        getServerExposureState,
      }));
      const registry = AtomRegistry.make();

      let unmount = registry.mount(atom);
      try {
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        unmount();
        yield* Effect.yieldNow;
        now.mockReturnValue(1_029_999);

        unmount = registry.mount(atom);
        expect(AsyncResult.value(registry.get(atom))).toEqual(
          expect.objectContaining({
            _tag: "Some",
            value: { advertisedEndpoints, serverExposureState },
          }),
        );
        expect(getServerExposureState).toHaveBeenCalledTimes(1);
        expect(getAdvertisedEndpoints).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
        registry.dispose();
        now.mockRestore();
      }
    }),
  );

  it.effect("keeps the previous snapshot while an explicit refresh loads current endpoints", () =>
    Effect.gen(function* () {
      let resolveEndpoints!: (value: ReadonlyArray<AdvertisedEndpoint>) => void;
      const nextEndpoints = new Promise<ReadonlyArray<AdvertisedEndpoint>>((resolve) => {
        resolveEndpoints = resolve;
      });
      const getAdvertisedEndpoints = vi
        .fn(async () => advertisedEndpoints)
        .mockResolvedValueOnce(advertisedEndpoints)
        .mockReturnValueOnce(nextEndpoints);
      const atom = createDesktopNetworkAccessStateAtom(() => ({
        getAdvertisedEndpoints,
        getServerExposureState: async () => serverExposureState,
      }));
      const registry = AtomRegistry.make();
      let unmount = registry.mount(atom);

      try {
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        registry.refresh(atom);
        unmount();
        yield* Effect.yieldNow;
        unmount = registry.mount(atom);

        expect(AsyncResult.value(registry.get(atom))).toEqual(
          expect.objectContaining({
            _tag: "Some",
            value: { advertisedEndpoints, serverExposureState },
          }),
        );
        resolveEndpoints([tailscaleEndpoint]);
        const refreshed = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        expect(refreshed.advertisedEndpoints).toEqual([tailscaleEndpoint]);
        expect(getAdvertisedEndpoints).toHaveBeenCalledTimes(2);
      } finally {
        resolveEndpoints([]);
        unmount();
        registry.dispose();
      }
    }),
  );

  it.effect.each([
    { change: "appears", before: [], after: [tailscaleEndpoint] },
    { change: "disappears", before: [tailscaleEndpoint], after: [] },
  ])("revalidates a stale snapshot when Tailscale $change between visits", ({ before, after }) =>
    Effect.gen(function* () {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const getServerExposureState = vi.fn(async () => serverExposureState);
      const getAdvertisedEndpoints = vi.fn(async () => before);
      const atom = createDesktopNetworkAccessStateAtom(() => ({
        getAdvertisedEndpoints,
        getServerExposureState,
      }));
      const registry = AtomRegistry.make();
      let unmount = registry.mount(atom);

      try {
        const initial = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        expect(initial.advertisedEndpoints).toEqual(before);
        unmount();
        yield* Effect.yieldNow;
        let markRefreshStarted!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
          markRefreshStarted = resolve;
        });
        getAdvertisedEndpoints.mockImplementation(async () => {
          markRefreshStarted();
          return after;
        });
        now.mockReturnValue(1_030_000);

        unmount = registry.mount(atom);
        // SWR schedules stale revalidation after the initial cached read.
        yield* Effect.promise(() => refreshStarted);
        const refreshed = yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        expect(refreshed.advertisedEndpoints).toEqual(after);
        expect(getServerExposureState).toHaveBeenCalledTimes(2);
        expect(getAdvertisedEndpoints).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
        registry.dispose();
        now.mockRestore();
      }
    }),
  );

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
