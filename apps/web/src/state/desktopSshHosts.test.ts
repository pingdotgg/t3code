import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";
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
});
