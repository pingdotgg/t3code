import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { devServerDescription, devServerLabel, resolveDevServerUrl } from "./devServers";

function server(overrides: Partial<DiscoveredLocalServer> = {}): DiscoveredLocalServer {
  return {
    host: "127.0.0.1",
    port: 5173,
    url: "http://localhost:5173/",
    processName: "node",
    pid: 4242,
    terminal: null,
    ...overrides,
  } as DiscoveredLocalServer;
}

describe("resolveDevServerUrl", () => {
  it("rewrites loopback URLs onto a LAN environment host", () => {
    const resolved = resolveDevServerUrl("http://192.168.1.20:4600", server());
    expect(resolved.url).toBe("http://192.168.1.20:5173/");
    expect(resolved.reachable).toBe(true);
  });

  it("rewrites loopback URLs onto a tailnet environment host", () => {
    const resolved = resolveDevServerUrl("https://laptop.tail1234.ts.net", server());
    expect(resolved.url).toBe("http://laptop.tail1234.ts.net:5173/");
    expect(resolved.reachable).toBe(true);
  });

  it("brackets IPv6 environment hosts", () => {
    const resolved = resolveDevServerUrl("http://[fd7a:115c:a1e0::1]:4600", server());
    expect(resolved.url).toBe("http://[fd7a:115c:a1e0::1]:5173/");
    expect(resolved.reachable).toBe(true);
  });

  it("keeps loopback URLs when the environment itself is loopback", () => {
    const resolved = resolveDevServerUrl("http://localhost:4600", server());
    expect(resolved.url).toBe("http://localhost:5173/");
    expect(resolved.reachable).toBe(true);
  });

  it("marks servers behind a public tunnel host unreachable", () => {
    const resolved = resolveDevServerUrl("https://box.tunnel.t3.codes", server());
    expect(resolved.reachable).toBe(false);
  });

  it("marks servers unreachable while the environment connection is unknown", () => {
    expect(resolveDevServerUrl(null, server()).reachable).toBe(false);
  });

  it("passes non-loopback discovered URLs through untouched", () => {
    const resolved = resolveDevServerUrl(
      "https://box.tunnel.t3.codes",
      server({ url: "http://192.168.1.30:8080/admin" }),
    );
    expect(resolved.url).toBe("http://192.168.1.30:8080/admin");
    expect(resolved.reachable).toBe(true);
  });
});

describe("dev server presentation", () => {
  it("labels servers by port and describes them by process", () => {
    expect(devServerLabel(server())).toBe("localhost:5173");
    expect(devServerDescription({ server: server(), url: "http://x/", reachable: true })).toBe(
      "node",
    );
    expect(devServerDescription({ server: server(), url: "http://x/", reachable: false })).toBe(
      "Not reachable over this connection",
    );
  });
});
