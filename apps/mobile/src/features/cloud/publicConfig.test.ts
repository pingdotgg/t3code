import { describe, expect, it, vi } from "vite-plus/test";

import { cloudAuthProvider, resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-secure-store", () => ({ getItem: () => null }));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      oidc: { issuer: null, clientId: null },
      relay: {
        url: null,
        managedTunnels: true,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("prefers an OpenID Connect provider over Clerk and still needs a secure relay", () => {
    const configured = resolveCloudPublicConfig({
      clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
      oidc: { issuer: "https://sso.example.test/realms/t3", clientId: "t3-code" },
      relay: { url: "https://relay.example.test" },
    });
    expect(cloudAuthProvider(configured)).toBe("oidc");

    const insecure = resolveCloudPublicConfig({
      oidc: { issuer: "https://sso.example.test/realms/t3", clientId: "t3-code" },
      relay: { url: "http://relay.example.test" },
    });
    expect(cloudAuthProvider(insecure)).toBeNull();
  });

  it("lets a relay chosen in settings replace the build's T3 Connect", () => {
    const configured = resolveCloudPublicConfig(
      {
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "https://relay.t3.example" },
        observability: {
          tracesUrl: "https://traces.t3.example",
          tracesDataset: "relay",
          tracesToken: "token",
        },
      },
      {
        relayUrl: "https://relay.example.test",
        oidcIssuer: "https://sso.example.test",
        oidcClientId: "t3-code",
        managedTunnels: false,
      },
    );
    expect(configured.relay).toEqual({ url: "https://relay.example.test", managedTunnels: false });
    expect(configured.observability.tracesUrl).toBeNull();
    expect(cloudAuthProvider(configured)).toBe("oidc");
  });
});
