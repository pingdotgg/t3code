import { describe, expect, it } from "vitest";

import { createDevProxyConfig, resolveDevProxyTarget } from "./devProxy.ts";

describe("web dev proxy", () => {
  it("targets the backend port for single-origin browser dev", () => {
    expect(resolveDevProxyTarget("13773", undefined)).toBe("http://localhost:13773/");
  });

  it("derives a proxy target from the explicit WebSocket URL when no port is set", () => {
    expect(resolveDevProxyTarget(undefined, "wss://dev.example.test:8443/ws?ticket=secret")).toBe(
      "https://dev.example.test:8443/",
    );
  });

  it("forwards the app WebSocket through Vite without changing existing backend routes", () => {
    const proxy = createDevProxyConfig("http://localhost:13773/");

    expect(proxy).toMatchObject({
      "/.well-known": { target: "http://localhost:13773/", changeOrigin: true },
      "/api": { target: "http://localhost:13773/", changeOrigin: true, ws: true },
      "/attachments": { target: "http://localhost:13773/", changeOrigin: true },
      "/oauth": { target: "http://localhost:13773/", changeOrigin: true },
      "/ws": { target: "http://localhost:13773/", changeOrigin: true, ws: true },
    });
  });

  it("does not enable backend proxies without a target", () => {
    expect(createDevProxyConfig(undefined)).toBeUndefined();
  });
});
