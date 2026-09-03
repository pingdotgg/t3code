import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopSshHostsStateAtom, filterDiscoveredSshHosts } from "./desktopSshHosts";

const hosts: ReadonlyArray<DesktopDiscoveredSshHost> = [
  {
    alias: "devbox",
    hostname: "devbox.local",
    port: null,
    source: "ssh-config",
    username: null,
  },
];

describe("filterDiscoveredSshHosts", () => {
  const suggestions: ReadonlyArray<DesktopDiscoveredSshHost> = [
    {
      alias: "grape",
      hostname: "grape",
      port: null,
      source: "known-hosts",
      username: null,
    },
    {
      alias: "Pinot",
      hostname: "Pinot",
      port: null,
      source: "ssh-config",
      username: null,
    },
    {
      alias: "preprod",
      hostname: "preprod",
      port: 2222,
      source: "ssh-config",
      username: "deploy",
    },
    {
      alias: "prod-z",
      hostname: "prod-z",
      port: null,
      source: "ssh-config",
      username: null,
    },
    {
      alias: "prod-a",
      hostname: "prod-a",
      port: null,
      source: "ssh-config",
      username: null,
    },
    {
      alias: "prod-m",
      hostname: "prod-m",
      port: null,
      source: "ssh-config",
      username: null,
    },
  ];

  it.each(["", "  "])("returns every host for an empty query %j", (query) => {
    expect(filterDiscoveredSshHosts(suggestions, query)).toEqual(suggestions);
  });

  it("trims the query", () => {
    expect(filterDiscoveredSshHosts(suggestions, "  pi ")).toEqual([suggestions[1]]);
  });

  it("ranks alias prefix matches before substring matches", () => {
    expect(filterDiscoveredSshHosts(suggestions, "prod")).toEqual([
      suggestions[3],
      suggestions[4],
      suggestions[5],
      suggestions[2],
    ]);
  });

  it("preserves the original order within a match tier", () => {
    expect(filterDiscoveredSshHosts(suggestions, "prod").slice(0, 3)).toEqual([
      suggestions[3],
      suggestions[4],
      suggestions[5],
    ]);
  });

  it("matches case-insensitively", () => {
    expect(filterDiscoveredSshHosts(suggestions, "PINOT")).toEqual([suggestions[1]]);
  });

  it("returns an empty array when no hosts match", () => {
    expect(filterDiscoveredSshHosts(suggestions, "merlot")).toEqual([]);
  });
});

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
