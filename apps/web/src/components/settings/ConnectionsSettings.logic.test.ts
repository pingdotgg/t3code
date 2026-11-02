import type { AdvertisedEndpoint, DesktopWslState } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  resolveTailscaleServeBaseUrl,
  resolveTailscaleHttpsRow,
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

describe("resolveTailscaleServeBaseUrl", () => {
  it.each([
    ["https://host.tail.ts.net:441/", 443, "https://host.tail.ts.net"],
    ["https://host.tail.ts.net:441/", 444, "https://host.tail.ts.net:444"],
  ] as const)("previews %s on port %i", (httpBaseUrl, port, expected) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, true)).toBe(expected);
  });

  it("returns null without a pending endpoint", () => {
    expect(resolveTailscaleServeBaseUrl(null, 443, true)).toBeNull();
  });

  it.each([
    ["https://host.tail.ts.net:441/", 0, false],
    ["not a URL", 443, true],
  ] as const)("preserves %s when port %i cannot be previewed", (httpBaseUrl, port, isPortValid) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, isPortValid)).toBe(httpBaseUrl);
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

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

describe("resolveTailscaleHttpsRow", () => {
  const provider = {
    id: "tailscale",
    label: "Tailscale",
    kind: "private-network",
    isAddon: true,
  } as const;
  const httpsEndpoint = (status: AdvertisedEndpoint["status"]) =>
    createAdvertisedEndpoint({
      id: "tailscale-magicdns:https://desktop.tail.ts.net/",
      label: "Tailscale HTTPS",
      provider,
      httpBaseUrl: "https://desktop.tail.ts.net/",
      reachability: "private-network",
      source: "desktop-addon",
      status,
    });
  const tailscaleIp = createAdvertisedEndpoint({
    id: "tailscale-ip:http://100.84.12.7:3773",
    label: "Tailscale IP",
    provider,
    httpBaseUrl: "http://100.84.12.7:3773",
    reachability: "private-network",
    source: "desktop-addon",
  });
  const SERVE = "Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL.";
  const START = "Start Tailscale to set up HTTPS access through MagicDNS.";
  const NO_MAGIC_DNS =
    "Tailscale is running, but its MagicDNS name could not be read. Make sure the tailscale command is installed and MagicDNS is on.";
  const UNREACHABLE = "This URL does not reach this backend yet, so pairing links leave it out.";

  it.each([
    {
      label: "keeps saved Serve on and shows the failed probe separately",
      state: { mode: "network-accessible", tailscaleServeEnabled: true },
      endpoints: [httpsEndpoint("unavailable")],
      expected: {
        description: "https://desktop.tail.ts.net/",
        status: UNREACHABLE,
        switchChecked: true,
      },
    },
    {
      label: "keeps saved Serve disableable when its endpoint disappears",
      state: { mode: "local-only", tailscaleServeEnabled: true },
      endpoints: [],
      expected: { description: START, status: null, switchChecked: true },
    },
    {
      label: "keeps Serve off when saved off, even if its URL answers",
      state: { mode: "network-accessible", tailscaleServeEnabled: false },
      endpoints: [httpsEndpoint("available")],
      expected: { description: SERVE, status: null, switchChecked: false },
    },
    {
      label: "offers Serve while Network access is off and detection was skipped",
      state: { mode: "local-only", tailscaleServeEnabled: false },
      endpoints: [],
      expected: { description: SERVE, status: null, switchChecked: false },
    },
    {
      label: "does not ask to start Tailscale when its adapter is up without MagicDNS",
      state: { mode: "network-accessible", tailscaleServeEnabled: false },
      endpoints: [tailscaleIp],
      expected: { description: NO_MAGIC_DNS, status: null, switchChecked: null },
    },
    {
      label: "asks to start Tailscale when network access found none",
      state: { mode: "network-accessible", tailscaleServeEnabled: false },
      endpoints: [],
      expected: { description: START, status: null, switchChecked: null },
    },
    {
      label: "hides the switch while the exposure state is unknown",
      state: null,
      endpoints: [],
      expected: { description: START, status: null, switchChecked: null },
    },
  ] as const)("$label", ({ state, endpoints, expected }) => {
    expect(resolveTailscaleHttpsRow({ state, endpoints })).toEqual(expected);
  });
});
