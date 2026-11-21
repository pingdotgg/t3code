import { describe, expect, it } from "vite-plus/test";

import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

describe("normalizeHttpBaseUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeHttpBaseUrl("ftp://example.com")).toThrow(/HTTP or HTTPS/);
  });
});

describe("createAdvertisedEndpoint", () => {
  const input = {
    id: "e1",
    label: "Local",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    reachability: "loopback",
    source: "desktop-core",
  } satisfies Omit<CreateAdvertisedEndpointInput, "httpBaseUrl">;

  it("marks plain-http endpoints as mixed-content blocked for hosted apps", () => {
    const endpoint = createAdvertisedEndpoint({
      ...input,
      httpBaseUrl: "http://192.168.1.10:8317",
    });
    expect(endpoint.compatibility.hostedHttpsApp).toBe("mixed-content-blocked");
    expect(endpoint.compatibility.desktopApp).toBe("compatible");
    expect(endpoint.wsBaseUrl).toBe("ws://192.168.1.10:8317/");
  });

  it("leaves https endpoints as unknown by default", () => {
    expect(
      createAdvertisedEndpoint({ ...input, httpBaseUrl: "https://example.com" }).compatibility
        .hostedHttpsApp,
    ).toBe("unknown");
  });

  it("uses an explicit hosted-https compatibility flag as given", () => {
    expect(
      createAdvertisedEndpoint({
        ...input,
        httpBaseUrl: "https://example.com",
        hostedHttpsCompatibility: "compatible",
      }).compatibility.hostedHttpsApp,
    ).toBe("compatible");
    expect(
      createAdvertisedEndpoint({
        ...input,
        httpBaseUrl: "https://example.com",
        hostedHttpsCompatibility: "mixed-content-blocked",
      }).compatibility.hostedHttpsApp,
    ).toBe("mixed-content-blocked");
  });
});
