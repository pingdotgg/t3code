import { describe, expect, it } from "@effect/vitest";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";

import { endpointMatches } from "./managedEndpointConnect.ts";

const endpoint: RelayManagedEndpoint = {
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
  providerKind: "cloudflare_tunnel",
};

describe("managedEndpointConnect smoke helpers", () => {
  it("matches only identical managed endpoint records", () => {
    expect(endpointMatches(endpoint, endpoint)).toBe(true);
    expect(
      endpointMatches(endpoint, {
        ...endpoint,
        httpBaseUrl: "https://other-desktop.example.test/",
      }),
    ).toBe(false);
    expect(
      endpointMatches(endpoint, {
        ...endpoint,
        wsBaseUrl: "wss://desktop.example.test/other-ws",
      }),
    ).toBe(false);
    expect(
      endpointMatches(endpoint, {
        ...endpoint,
        providerKind: "manual",
      }),
    ).toBe(false);
  });
});
