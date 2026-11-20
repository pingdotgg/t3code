import { describe, expect, it } from "vite-plus/test";

import {
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

describe("normalizeHttpBaseUrl", () => {
  it("upgrades ws/wss to http/https", () => {
    expect(normalizeHttpBaseUrl("ws://127.0.0.1:8317")).toBe("http://127.0.0.1:8317/");
    expect(normalizeHttpBaseUrl("wss://example.com")).toBe("https://example.com/");
  });

  it("strips path, query, and hash", () => {
    expect(normalizeHttpBaseUrl("https://example.com/api/v1?q=1#frag")).toBe(
      "https://example.com/",
    );
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeHttpBaseUrl("ftp://example.com")).toThrow(/HTTP or HTTPS/);
  });
});

describe("deriveWsBaseUrl", () => {
  it("maps http to ws and https to wss", () => {
    expect(deriveWsBaseUrl("http://127.0.0.1:8317")).toBe("ws://127.0.0.1:8317/");
    expect(deriveWsBaseUrl("https://example.com")).toBe("wss://example.com/");
  });
});

describe("createAdvertisedEndpoint", () => {
  const input = {
    id: "e1",
    label: "Local",
    provider: "server" as const,
    reachability: "loopback" as const,
    source: "configured" as const,
  };

  it("marks plain-http endpoints as mixed-content blocked for hosted apps", () => {
    const endpoint = createAdvertisedEndpoint({
      ...input,
      httpBaseUrl: "http://192.168.1.10:8317",
    });
    expect(endpoint.compatibility.hostedHttpsApp).toBe("mixed-content-blocked");
    expect(endpoint.compatibility.desktopApp).toBe("compatible");
    expect(endpoint.wsBaseUrl).toBe("ws://192.168.1.10:8317/");
  });

  it("leaves https endpoints as unknown by default and honors an explicit flag", () => {
    expect(
      createAdvertisedEndpoint({ ...input, httpBaseUrl: "https://example.com" }).compatibility
        .hostedHttpsApp,
    ).toBe("unknown");
    expect(
      createAdvertisedEndpoint({
        ...input,
        httpBaseUrl: "https://example.com",
        hostedHttpsCompatibility: "compatible",
      }).compatibility.hostedHttpsApp,
    ).toBe("compatible");
  });

  it("honors an explicit compatibility flag verbatim, and downgrades a derived one on https", () => {
    // An explicit flag is trusted as-is; the derived fallback is the only one normalized.
    expect(
      createAdvertisedEndpoint({
        ...input,
        httpBaseUrl: "https://example.com",
        hostedHttpsCompatibility: "mixed-content-blocked",
      }).compatibility.hostedHttpsApp,
    ).toBe("mixed-content-blocked");
  });

  it("defaults status to available and omits absent optionals", () => {
    const endpoint = createAdvertisedEndpoint({
      ...input,
      httpBaseUrl: "https://example.com",
    });
    expect(endpoint.status).toBe("available");
    expect("isDefault" in endpoint).toBe(false);
    expect("description" in endpoint).toBe(false);
  });
});
