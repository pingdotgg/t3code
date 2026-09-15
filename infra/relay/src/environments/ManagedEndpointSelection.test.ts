import { describe, expect, it } from "vite-plus/test";

import { selectManagedEndpointProvider } from "./ManagedEndpointSelection.ts";

const request = (
  supportedManagedEndpointProviders?: ReadonlyArray<"cloudflare_tunnel" | "t3_relay">,
) => ({
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  managedTunnelsEnabled: true,
  ...(supportedManagedEndpointProviders === undefined ? {} : { supportedManagedEndpointProviders }),
});

describe("managed endpoint selection", () => {
  it("keeps legacy hosts on Cloudflare", () => {
    expect(
      selectManagedEndpointProvider({
        request: request(),
        preferredProvider: "t3_relay",
      }),
    ).toBe("cloudflare_tunnel");
  });

  it("selects t3_relay only when both deployment and host support it", () => {
    expect(
      selectManagedEndpointProvider({
        request: request(["cloudflare_tunnel", "t3_relay"]),
        preferredProvider: "t3_relay",
      }),
    ).toBe("t3_relay");
    expect(
      selectManagedEndpointProvider({
        request: request(["cloudflare_tunnel", "t3_relay"]),
        preferredProvider: "cloudflare_tunnel",
      }),
    ).toBe("cloudflare_tunnel");
  });

  it("does not select a managed provider for publish-only links", () => {
    expect(
      selectManagedEndpointProvider({
        request: { ...request(["cloudflare_tunnel", "t3_relay"]), managedTunnelsEnabled: false },
        preferredProvider: "t3_relay",
      }),
    ).toBeNull();
  });

  it("does not select a provider the host did not advertise", () => {
    expect(
      selectManagedEndpointProvider({
        request: request(["t3_relay"]),
        preferredProvider: "cloudflare_tunnel",
      }),
    ).toBeNull();
    expect(
      selectManagedEndpointProvider({
        request: request([]),
        preferredProvider: "t3_relay",
      }),
    ).toBeNull();
  });
});
