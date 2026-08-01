import type { AdvertisedEndpoint, DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  endpointDefaultPreferenceKey,
  isQrShareableEndpoint,
  selectPairingEndpoint,
  selectQrEndpointOption,
} from "./ConnectionsSettings.logic";

const DESKTOP_CORE_PROVIDER: AdvertisedEndpoint["provider"] = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const COMPATIBLE_COMPATIBILITY: AdvertisedEndpoint["compatibility"] = {
  hostedHttpsApp: "mixed-content-blocked",
  desktopApp: "compatible",
};

function makeLanEndpoint(input: {
  readonly address: string;
  readonly port: number;
  readonly isDefault?: boolean;
}): AdvertisedEndpoint {
  const httpBaseUrl = `http://${input.address}:${input.port}/`;
  return {
    id: `desktop-lan:http://${input.address}:${input.port}`,
    label: "Local network",
    provider: DESKTOP_CORE_PROVIDER,
    httpBaseUrl,
    wsBaseUrl: `ws://${input.address}:${input.port}/`,
    reachability: "lan",
    compatibility: COMPATIBLE_COMPATIBILITY,
    source: "desktop-core",
    status: "available",
    ...(input.isDefault ? { isDefault: true } : {}),
    description: "Reachable from devices on the same network.",
  };
}

function makeLoopbackEndpoint(port: number): AdvertisedEndpoint {
  const httpBaseUrl = `http://127.0.0.1:${port}/`;
  return {
    id: `desktop-loopback:${port}`,
    label: "This machine",
    provider: DESKTOP_CORE_PROVIDER,
    httpBaseUrl,
    wsBaseUrl: `ws://127.0.0.1:${port}/`,
    reachability: "loopback",
    compatibility: COMPATIBLE_COMPATIBILITY,
    source: "desktop-core",
    status: "available",
    description: "Loopback endpoint for this desktop app.",
  };
}

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

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

describe("endpointDefaultPreferenceKey", () => {
  it("gives distinct desktop-lan endpoints on different hosts distinct preference keys", () => {
    const first = makeLanEndpoint({ address: "10.8.0.5", port: 4173 });
    const second = makeLanEndpoint({ address: "192.168.1.20", port: 4173 });

    expect(endpointDefaultPreferenceKey(first)).toBe("desktop-core:lan:http:10.8.0.5:4173");
    expect(endpointDefaultPreferenceKey(second)).toBe("desktop-core:lan:http:192.168.1.20:4173");
    expect(endpointDefaultPreferenceKey(first)).not.toBe(endpointDefaultPreferenceKey(second));
  });

  it("keeps the loopback preference key stable", () => {
    expect(endpointDefaultPreferenceKey(makeLoopbackEndpoint(4173))).toBe(
      "desktop-core:loopback:http",
    );
  });

  it("distinguishes manual endpoints that share a label by host", () => {
    const makeManualEndpoint = (url: string): AdvertisedEndpoint => ({
      id: `manual:${url}`,
      label: "Custom HTTPS",
      provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
      httpBaseUrl: `${url}/`,
      wsBaseUrl: `${url.replace("https:", "wss:")}/`,
      reachability: "public",
      compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
      source: "user",
      status: "unknown",
      description: "User-configured HTTPS endpoint for this desktop backend.",
    });
    const first = makeManualEndpoint("https://one.example.test");
    const second = makeManualEndpoint("https://two.example.test");

    expect(endpointDefaultPreferenceKey(first)).not.toBe(endpointDefaultPreferenceKey(second));
  });

  it("embeds the host in tailscale-ip preference keys", () => {
    const endpoint: AdvertisedEndpoint = {
      id: "tailscale-ip:http://100.90.1.2:4173",
      label: "Tailscale IP",
      provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
      httpBaseUrl: "http://100.90.1.2:4173/",
      wsBaseUrl: "ws://100.90.1.2:4173/",
      reachability: "private-network",
      compatibility: COMPATIBLE_COMPATIBILITY,
      source: "desktop-addon",
      status: "available",
      description: "Reachable from devices on the same Tailnet.",
    };

    expect(endpointDefaultPreferenceKey(endpoint)).toBe("tailscale:ip:http:100.90.1.2:4173");
  });
});

describe("selectPairingEndpoint", () => {
  it("selects the endpoint matching a stored preference key for the second LAN address", () => {
    const first = makeLanEndpoint({ address: "10.8.0.5", port: 4173, isDefault: true });
    const second = makeLanEndpoint({ address: "192.168.1.20", port: 4173 });

    const selected = selectPairingEndpoint([first, second], endpointDefaultPreferenceKey(second));

    expect(selected).toBe(second);
  });

  it("falls back to the default endpoint when a legacy preference key matches nothing", () => {
    const first = makeLanEndpoint({ address: "10.8.0.5", port: 4173, isDefault: true });
    const second = makeLanEndpoint({ address: "192.168.1.20", port: 4173 });

    const selected = selectPairingEndpoint([first, second], "desktop-core:lan:http");

    expect(selected).toBe(first);
  });
});
