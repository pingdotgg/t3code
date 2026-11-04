import type { DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  resolveTailscaleServeBaseUrl,
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
