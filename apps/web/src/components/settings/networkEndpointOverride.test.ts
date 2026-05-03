import { describe, expect, it } from "vitest";

import { resolveDesktopNetworkEndpointUrl } from "./networkEndpointOverride";

describe("resolveDesktopNetworkEndpointUrl", () => {
  it("returns the default endpoint when no override is provided", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: "http://192.168.1.44:3773",
      customHostnameOrUrl: "   ",
    });

    expect(result).toEqual({
      endpointUrl: "http://192.168.1.44:3773",
      customValue: null,
      usesCustomEndpoint: false,
      error: null,
    });
  });

  it("overrides hostname while keeping protocol and port", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: "http://192.168.1.44:3773",
      customHostnameOrUrl: "devbox.local",
    });

    expect(result).toEqual({
      endpointUrl: "http://devbox.local:3773",
      customValue: "devbox.local",
      usesCustomEndpoint: true,
      error: null,
    });
  });

  it("overrides hostname and port when host:port is provided", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: "http://192.168.1.44:3773",
      customHostnameOrUrl: "devbox.local:7777",
    });

    expect(result).toEqual({
      endpointUrl: "http://devbox.local:7777",
      customValue: "devbox.local:7777",
      usesCustomEndpoint: true,
      error: null,
    });
  });

  it("overrides scheme and host when a full URL is provided", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: "http://192.168.1.44:3773",
      customHostnameOrUrl: "https://demo.example.com",
    });

    expect(result).toEqual({
      endpointUrl: "https://demo.example.com",
      customValue: "https://demo.example.com",
      usesCustomEndpoint: true,
      error: null,
    });
  });

  it("accepts a full URL when the default endpoint is not available", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: null,
      customHostnameOrUrl: "https://demo.example.com:8443/path",
    });

    expect(result).toEqual({
      endpointUrl: "https://demo.example.com:8443",
      customValue: "https://demo.example.com:8443/path",
      usesCustomEndpoint: true,
      error: null,
    });
  });

  it("keeps the fallback endpoint and returns an error for invalid host input", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: "http://192.168.1.44:3773",
      customHostnameOrUrl: "demo.example.com/path",
    });

    expect(result).toEqual({
      endpointUrl: "http://192.168.1.44:3773",
      customValue: "demo.example.com/path",
      usesCustomEndpoint: false,
      error: "Enter only a hostname (and optional port), or a full URL.",
    });
  });

  it("requires a full URL when no default endpoint is available", () => {
    const result = resolveDesktopNetworkEndpointUrl({
      endpointUrl: null,
      customHostnameOrUrl: "demo.example.com",
    });

    expect(result).toEqual({
      endpointUrl: null,
      customValue: "demo.example.com",
      usesCustomEndpoint: false,
      error: "Enter a full URL while network access is loading.",
    });
  });
});
