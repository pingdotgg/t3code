import type { DesktopWslState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyWslEnableSelection,
  formatGatewayOrigin,
  gatewayHeadersFromDraft,
  type GatewayHeadersDraft,
  makeGatewayHeadersDraft,
  resolveGatewayOrigin,
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

describe("gatewayHeadersFromDraft", () => {
  const custom = (...rows: Array<[string, string]>): GatewayHeadersDraft => ({
    ...makeGatewayHeadersDraft(["X"]),
    rows: rows.map(([name, value], index) => ({ id: String(index), name, value })),
  });

  it("sends a Cloudflare service token as its two headers", () => {
    expect(
      gatewayHeadersFromDraft({
        ...makeGatewayHeadersDraft(),
        clientId: " id.access ",
        clientSecret: "a:b",
      }),
    ).toEqual([
      { name: "CF-Access-Client-Id", value: "id.access" },
      { name: "CF-Access-Client-Secret", value: "a:b" },
    ]);
  });

  it("sends nothing when no field is filled in", () => {
    expect(gatewayHeadersFromDraft(makeGatewayHeadersDraft())).toEqual([]);
    expect(gatewayHeadersFromDraft(custom(["", " "]))).toEqual([]);
  });

  it.each([
    ["half a service token", { ...makeGatewayHeadersDraft(), clientId: "id" }, "client secret"],
    ["a value without a name", custom(["", "secret"]), "Enter a name for each header."],
    ["a name without a value", custom(["P-Token", ""]), "Enter a value for P-Token."],
    ["a header T3 Code sets", custom(["Authorization", "x"]), "T3 Code sets Authorization"],
    ["a browser-owned header", custom(["Sec-WebSocket-Key", "x"]), "T3 Code sets Sec-WebSocket"],
    ["an invalid name", custom(["Bad Name", "x"]), "Bad Name is not a valid header name."],
    ["a repeated name", custom(["X-Token", "a"], ["x-token", "b"]), "x-token is listed twice."],
  ])("rejects %s without echoing a value", (_label, draft, message) => {
    expect(() => gatewayHeadersFromDraft(draft)).toThrow(message);
  });

  it("opens a replacement on the kind of headers already saved", () => {
    expect(makeGatewayHeadersDraft(["cf-access-client-secret", "CF-Access-Client-Id"]).kind).toBe(
      "cloudflare",
    );
    expect(makeGatewayHeadersDraft(["P-Access-Token"]).rows.map((row) => row.name)).toEqual([
      "P-Access-Token",
    ]);
  });
});

describe("resolveGatewayOrigin", () => {
  it.each([
    ["code.example.com", "https://code.example.com"],
    ["https://code.example.com/pair?token=x#y", "https://code.example.com"],
    ["wss://code.example.com:8443/ws", "https://code.example.com:8443"],
    ["http://192.168.1.4:3773", "http://192.168.1.4:3773"],
  ])("resolves %s to %s", (host, origin) => {
    expect(resolveGatewayOrigin(host)).toBe(origin);
  });

  it("rejects non-http addresses", () => {
    expect(() => resolveGatewayOrigin("ftp://code.example.com")).toThrow("http or https");
  });

  it("formats an https origin as its host", () => {
    expect(formatGatewayOrigin("https://code.example.com")).toBe("code.example.com");
    expect(formatGatewayOrigin("http://192.168.1.4:3773")).toBe("http://192.168.1.4:3773");
  });
});
