import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopSshHostsStateAtom } from "./desktopSshHosts";

const hosts: ReadonlyArray<DesktopDiscoveredSshHost> = [
  {
    alias: "devbox",
    hostname: "devbox.local",
    port: null,
    source: "ssh-config",
    username: null,
  },
];

describe("desktopSshHostsState", () => {
  it("retains discovered hosts when the settings screen remounts", async () => {
    const discoverSshHosts = vi.fn(async () => hosts);
    const atom = createDesktopSshHostsStateAtom(() => ({ discoverSshHosts }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: hosts }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "Some", value: hosts }),
    );
    expect(discoverSshHosts).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("retains the desktop bridge failure as the discovery error cause", async () => {
    const cause = new Error("ssh config unavailable");
    const atom = createDesktopSshHostsStateAtom(() => ({
      discoverSshHosts: async () => Promise.reject(cause),
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected SSH host discovery to fail.");

    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({
        _tag: "DesktopSshDiscoveryError",
        cause,
      }),
    );
    registry.dispose();
  });
});
