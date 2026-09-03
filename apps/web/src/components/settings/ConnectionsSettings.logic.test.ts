import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type AdvertisedEndpoint,
  type DesktopWslState,
  type RunningLocalServer,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  environmentPairingBaseUrl,
  isQrShareableEndpoint,
  isWslSettingsRowVisible,
  selectLocalServerPairingCandidates,
  selectQrEndpointOption,
} from "./ConnectionsSettings.logic";

const savedEnvironmentId = EnvironmentId.make("saved-environment");

function connectionEntry(
  target: ConnectionCatalogEntry["target"],
  profile?: ConnectionCatalogEntry["profile"] extends Option.Option<infer A> ? A : never,
): ConnectionCatalogEntry {
  return {
    target,
    profile: profile === undefined ? Option.none() : Option.some(profile),
  };
}

describe("environmentPairingBaseUrl", () => {
  it("uses the reachable origin from a bearer environment profile", () => {
    expect(
      environmentPairingBaseUrl(
        connectionEntry(
          new BearerConnectionTarget({
            environmentId: savedEnvironmentId,
            label: "headless",
            connectionId: "bearer:saved-environment",
          }),
          new BearerConnectionProfile({
            connectionId: "bearer:saved-environment",
            environmentId: savedEnvironmentId,
            label: "headless",
            httpBaseUrl: "https://box.tail.ts.net/",
            wsBaseUrl: "wss://box.tail.ts.net/",
          }),
        ),
      ),
    ).toBe("https://box.tail.ts.net/");
  });

  it("does not share an SSH tunnel's client-local address", () => {
    expect(
      environmentPairingBaseUrl(
        connectionEntry(
          new SshConnectionTarget({
            environmentId: savedEnvironmentId,
            label: "box",
            connectionId: "ssh:box",
          }),
          new SshConnectionProfile({
            connectionId: "ssh:box",
            environmentId: savedEnvironmentId,
            label: "box",
            target: { alias: "box", hostname: "box", username: "ivan", port: 22 },
          }),
        ),
      ),
    ).toBeNull();
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("isWslSettingsRowVisible", () => {
  it("shows the retry row when the WSL state failed to load", () => {
    expect(isWslSettingsRowVisible({ state: null, error: "load failed" })).toBe(true);
  });

  it("hides an unavailable and unused WSL snapshot", () => {
    expect(
      isWslSettingsRowVisible({
        state: { ...baseWslState, available: false, wslOnly: false },
        error: null,
      }),
    ).toBe(false);
  });

  it("shows an available WSL snapshot", () => {
    expect(isWslSettingsRowVisible({ state: baseWslState, error: null })).toBe(true);
  });
});

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });

  it("stages WSL-only before enabling without rewriting an unchanged distro", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = false;
    const setWslDistro = vi.fn(async () => baseWslState);
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, wslOnly: enabled };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return { ...baseWslState, enabled, wslOnly: persistedWslOnly };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "wsl-only",
      nextDistro: null,
      persistedDistro: null,
    });

    expect(calls).toEqual(["setWslOnly:true", "setWslBackendEnabled:true"]);
    expect(setWslDistro).not.toHaveBeenCalled();
    expect(state).toMatchObject({ enabled: true, wslOnly: true });
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("isQrShareableEndpoint", () => {
  it("excludes loopback endpoints so a scanned phone never dials itself", () => {
    expect(
      isQrShareableEndpoint(
        makeEndpoint({
          id: "desktop-loopback:4780",
          reachability: "loopback",
          httpBaseUrl: "http://127.0.0.1:4780",
        }),
      ),
    ).toBe(false);
  });

  it("excludes unavailable endpoints and keeps reachable ones", () => {
    expect(isQrShareableEndpoint(makeEndpoint({ status: "unavailable" }))).toBe(false);
    expect(isQrShareableEndpoint(makeEndpoint({}))).toBe(true);
    expect(
      isQrShareableEndpoint(makeEndpoint({ reachability: "private-network", status: "unknown" })),
    ).toBe(true);
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("falls back to the saved default preference key when nothing is selected", () => {
    expect(selectQrEndpointOption(options, null, "desktop-core:lan:http")?.id).toBe(
      "desktop-lan:http://192.168.1.42:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });

  it("returns the first option when nothing is QR-shareable, and null when empty", () => {
    const loopbackOnly = options.slice(0, 1);
    expect(selectQrEndpointOption(loopbackOnly, null, null)?.id).toBe("desktop-loopback:4780");
    expect(selectQrEndpointOption([], "anything", "anything")).toBeNull();
  });
});

describe("selectLocalServerPairingCandidates", () => {
  const server = {
    statePath: "/home/user/.t3/userdata/server-runtime.json",
    baseDir: "/home/user/.t3",
    variant: "userdata",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    httpBaseUrl: "http://127.0.0.1:3773/",
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local server",
  } satisfies RunningLocalServer;

  it("marks connected servers as paired and reconnecting servers for pairing again", () => {
    expect(
      selectLocalServerPairingCandidates(
        [server],
        [{ environmentId: server.environmentId, connection: { phase: "connected" } }],
      ),
    ).toEqual([{ server, pairAgain: false, alreadyPaired: true }]);
    expect(
      selectLocalServerPairingCandidates(
        [server],
        [{ environmentId: server.environmentId, connection: { phase: "reconnecting" } }],
      ),
    ).toEqual([{ server, pairAgain: true, alreadyPaired: false }]);
  });
});
