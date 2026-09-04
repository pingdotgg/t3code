import type { TailcatConnectionDiagnostics } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopTailcatDiagnosticsAtomFamily,
  isDesktopTailcatAvailable,
} from "./desktopTailcat";

const diagnostics: TailcatConnectionDiagnostics = {
  connectionId: "tailcat:env-1",
  address: `tc${"a".repeat(40)}`,
  remotePort: 3773,
  status: "ready",
  localEndpoint: "127.0.0.1:41234",
  pid: 4242,
  runtime: {
    executablePath: "/opt/t3/tailcat",
    source: "bundled",
    version: "0.5.0",
    pinnedVersion: "0.5.0",
    compatible: true,
  },
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
