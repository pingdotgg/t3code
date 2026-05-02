import { describe, expect, it } from "vitest";

import { resolveDesktopTailnetUrl } from "./ConnectionsSettings.logic";

describe("resolveDesktopTailnetUrl", () => {
  it("returns null when network access is disabled", () => {
    expect(
      resolveDesktopTailnetUrl(
        {
          mode: "local-only",
          endpointUrl: "http://192.168.1.44:3773",
          advertisedHost: "192.168.1.44",
        },
        {
          available: true,
          connected: true,
          hostname: "clays-macbook-pro.tail744884.ts.net",
          ipv4: "100.97.126.33",
          error: null,
        },
      ),
    ).toBeNull();
  });

  it("returns null when tailnet connectivity is unavailable", () => {
    expect(
      resolveDesktopTailnetUrl(
        {
          mode: "network-accessible",
          endpointUrl: "http://192.168.1.44:3773",
          advertisedHost: "192.168.1.44",
        },
        {
          available: true,
          connected: false,
          hostname: "clays-macbook-pro.tail744884.ts.net",
          ipv4: null,
          error: null,
        },
      ),
    ).toBeNull();
  });

  it("replaces the advertised host with the tailnet hostname", () => {
    expect(
      resolveDesktopTailnetUrl(
        {
          mode: "network-accessible",
          endpointUrl: "http://192.168.1.44:3773/pair",
          advertisedHost: "192.168.1.44",
        },
        {
          available: true,
          connected: true,
          hostname: "clays-macbook-pro.tail744884.ts.net",
          ipv4: "100.97.126.33",
          error: null,
        },
      ),
    ).toBe("http://clays-macbook-pro.tail744884.ts.net:3773/pair");
  });
});
