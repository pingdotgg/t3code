import { describe, expect, it, vi } from "vitest";

import { resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  ", jwtTemplate: "  t3-relay  " },
        relay: { url: " https://relay.example.test/// " },
      }),
    ).toEqual({
      clerkPublishableKey: "pk_test_example",
      clerkJwtTemplate: "t3-relay",
      relayUrl: "https://relay.example.test",
    });
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerkPublishableKey: "pk_test_example",
      clerkJwtTemplate: "t3-relay",
      relayUrl: null,
    });
  });
});
