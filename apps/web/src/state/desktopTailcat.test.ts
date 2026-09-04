import type { TailcatConnectionDiagnostics, TailcatRuntimeAvailability } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopTailcatDiagnosticsAtomFamily,
  createDesktopTailcatRuntimeAvailabilityAtom,
  isDesktopTailcatAvailable,
} from "./desktopTailcat";

const runtimeAvailability: TailcatRuntimeAvailability = {
  available: true,
  runtime: {
    executablePath: "/opt/t3/tailcat",
    source: "bundled",
    version: "0.5.0",
    pinnedVersion: "0.5.0",
    compatible: true,
  },
};

const diagnostics: TailcatConnectionDiagnostics = {
  connectionId: "tailcat:env-1",
  address: `tc${"a".repeat(40)}`,
  remotePort: 3773,
  status: "ready",
  localEndpoint: "127.0.0.1:41234",
  pid: 4242,
  runtime: runtimeAvailability.runtime,
  clientNodeKey: `nodekey:${"0".repeat(64)}`,
  path: null,
  startedAt: "2026-09-03T10:00:00.000Z",
  restartCount: 0,
  lastError: null,
  recentOutput: [],
};

describe("isDesktopTailcatAvailable", () => {
  it("requires a bridge that can start tunnels", () => {
    expect(isDesktopTailcatAvailable(undefined)).toBe(false);
    expect(isDesktopTailcatAvailable({})).toBe(false);
    expect(isDesktopTailcatAvailable({ ensureTailcatEnvironment: vi.fn() })).toBe(true);
  });
});

describe("desktopTailcatRuntimeAvailability", () => {
  it("retains the loaded runtime when the settings screen remounts", async () => {
    const getTailcatRuntimeAvailability = vi.fn(async () => runtimeAvailability);
    const atom = createDesktopTailcatRuntimeAvailabilityAtom(() => ({
      ensureTailcatEnvironment: vi.fn(),
      getTailcatRuntimeAvailability,
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
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "Some", value: runtimeAvailability }),
    );
    expect(getTailcatRuntimeAvailability).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("fails as unavailable when the bridge predates Tailcat", async () => {
    const atom = createDesktopTailcatRuntimeAvailabilityAtom(() => ({}));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected the runtime load to fail.");
    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({ _tag: "DesktopTailcatUnavailableError" }),
    );
    registry.dispose();
  });
});

describe("desktopTailcatDiagnostics", () => {
  it("loads diagnostics per connection id and keeps the bridge failure cause", async () => {
    const bridgeFailure = new Error("[tailcat:unknown] forwarder table locked");
    const getTailcatConnectionDiagnostics = vi.fn(async (connectionId: string) => {
      if (connectionId === "tailcat:env-broken") throw bridgeFailure;
      return connectionId === diagnostics.connectionId ? diagnostics : null;
    });
    const family = createDesktopTailcatDiagnosticsAtomFamily(() => ({
      ensureTailcatEnvironment: vi.fn(),
      getTailcatConnectionDiagnostics,
    }));
    const registry = AtomRegistry.make();

    const ready = family("tailcat:env-1");
    const missing = family("tailcat:env-2");
    const broken = family("tailcat:env-broken");
    registry.mount(ready);
    registry.mount(missing);
    registry.mount(broken);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(ready))).toEqual(
        expect.objectContaining({ _tag: "Some", value: diagnostics }),
      );
      expect(AsyncResult.value(registry.get(missing))).toEqual(
        expect.objectContaining({ _tag: "Some", value: null }),
      );
      expect(AsyncResult.isFailure(registry.get(broken))).toBe(true);
    });
    const failed = registry.get(broken);
    if (!AsyncResult.isFailure(failed)) throw new Error("Expected the diagnostics load to fail.");
    expect(Cause.squash(failed.cause)).toEqual(
      expect.objectContaining({ _tag: "DesktopTailcatBridgeError", cause: bridgeFailure }),
    );
    expect(getTailcatConnectionDiagnostics.mock.calls.map(([id]) => id)).toEqual([
      "tailcat:env-1",
      "tailcat:env-2",
      "tailcat:env-broken",
    ]);
    registry.dispose();
  });
});
