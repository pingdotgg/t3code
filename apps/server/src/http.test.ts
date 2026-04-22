import { describe, expect, it } from "vitest";

import {
  isAllowedBrowserApiCorsOrigin,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("browser API CORS origin allowlist", () => {
  it("allows loopback and RFC6761 .localhost dev origins", () => {
    expect(isAllowedBrowserApiCorsOrigin("http://localhost:5733")).toBe(true);
    expect(isAllowedBrowserApiCorsOrigin("http://127.0.0.1:5733")).toBe(true);
    expect(isAllowedBrowserApiCorsOrigin("http://vite.localhost:5733")).toBe(true);
  });

  it("allows Tailscale CGNAT and common private LAN ranges", () => {
    expect(isAllowedBrowserApiCorsOrigin("http://100.91.197.39:5733")).toBe(true);
    expect(isAllowedBrowserApiCorsOrigin("http://192.168.1.10:5733")).toBe(true);
    expect(isAllowedBrowserApiCorsOrigin("http://10.0.0.5:5733")).toBe(true);
    expect(isAllowedBrowserApiCorsOrigin("http://172.20.0.2:5733")).toBe(true);
  });

  it("rejects missing, invalid, or public origins", () => {
    expect(isAllowedBrowserApiCorsOrigin(undefined)).toBe(false);
    expect(isAllowedBrowserApiCorsOrigin("")).toBe(false);
    expect(isAllowedBrowserApiCorsOrigin("not-a-url")).toBe(false);
    expect(isAllowedBrowserApiCorsOrigin("https://example.com")).toBe(false);
    expect(isAllowedBrowserApiCorsOrigin("http://185.199.108.153:5733")).toBe(false);
  });
});
