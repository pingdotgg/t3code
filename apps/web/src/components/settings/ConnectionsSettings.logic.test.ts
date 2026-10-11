import type { AdvertisedEndpoint, DesktopUpdateState, DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  canRevokeOtherClients,
  isQrShareableEndpoint,
  isWslSettingsRowVisible,
  resolveLocalVersionStatusLabel,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
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

describe("resolveLocalVersionStatusLabel", () => {
  const baseState: DesktopUpdateState = {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.0.0",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  it("keeps the web client up to date without desktop state", () => {
    expect(resolveLocalVersionStatusLabel(null)).toBe("Up to date");
  });

  it.each<DesktopUpdateState["status"]>(["idle", "up-to-date", "checking", "disabled", "error"])(
    "keeps a quiet %s updater up to date",
    (status) => {
      expect(resolveLocalVersionStatusLabel({ ...baseState, status })).toBe("Up to date");
    },
  );

  it("keeps the downloaded version pending during a recheck", () => {
    const label = resolveLocalVersionStatusLabel({
      ...baseState,
      status: "checking",
      downloadedVersion: "1.1.0",
    });

    expect(label).not.toBe("Up to date");
    expect(label).toContain("1.1.0");
    expect(label).toMatch(/downloaded/i);
  });

  it("stays up to date during a recheck with only an available version", () => {
    expect(
      resolveLocalVersionStatusLabel({
        ...baseState,
        status: "checking",
        availableVersion: "1.1.0",
      }),
    ).toBe("Up to date");
  });

  it("stays up to date after a failed check with only an available version", () => {
    expect(
      resolveLocalVersionStatusLabel({
        ...baseState,
        status: "error",
        errorContext: "check",
        availableVersion: "1.1.0",
      }),
    ).toBe("Up to date");
  });

  it.each<DesktopUpdateState["status"]>(["available", "downloading", "downloaded"])(
    "names the pending version when %s, falling back to the available version",
    (status) => {
      const label = resolveLocalVersionStatusLabel({
        ...baseState,
        status,
        availableVersion: "1.1.0",
      });

      expect(label).not.toBe("Up to date");
      expect(label).toContain("1.1.0");
      expect(label).toMatch(new RegExp(status, "i"));
    },
  );

  it("prefers the downloaded version over the available version", () => {
    const label = resolveLocalVersionStatusLabel({
      ...baseState,
      status: "downloaded",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    });

    expect(label).toContain("1.1.0");
    expect(label).not.toContain("1.2.0");
  });

  it("names the available version after a failed download", () => {
    const label = resolveLocalVersionStatusLabel({
      ...baseState,
      status: "error",
      errorContext: "download",
      availableVersion: "1.1.0",
      canRetry: true,
    });

    expect(label).not.toBe("Up to date");
    expect(label).toContain("1.1.0");
  });

  it.each<DesktopUpdateState["errorContext"]>(["install", null])(
    "names the downloaded version after an error with %s context",
    (errorContext) => {
      const label = resolveLocalVersionStatusLabel({
        ...baseState,
        status: "error",
        errorContext,
        availableVersion: "1.2.0",
        downloadedVersion: "1.1.0",
      });

      expect(label).not.toBe("Up to date");
      expect(label).toContain("1.1.0");
      expect(label).not.toContain("1.2.0");
    },
  );

  it.each<DesktopUpdateState["status"]>(["available", "downloading", "downloaded"])(
    "does not claim up to date when %s without a known version",
    (status) => {
      const label = resolveLocalVersionStatusLabel({ ...baseState, status });

      expect(label).not.toBe("Up to date");
      expect(label).toMatch(new RegExp(status, "i"));
    },
  );
});

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

describe("canRevokeOtherClients", () => {
  it("permits revocation when a write-only grant cannot list clients", () => {
    expect(canRevokeOtherClients(null)).toBe(true);
  });

  it("disables revocation only when a loaded list has no other clients", () => {
    expect(canRevokeOtherClients([])).toBe(false);
    expect(canRevokeOtherClients([{ current: true }])).toBe(false);
    expect(canRevokeOtherClients([{ current: true }, { current: false }])).toBe(true);
  });
});
