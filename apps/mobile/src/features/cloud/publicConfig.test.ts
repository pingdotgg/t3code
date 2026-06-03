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
      relayUrl: null,
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  " },
        relay: { url: " https://relay.example.test/// " },
      }),
    ).toEqual({
      clerkPublishableKey: "pk_test_example",
      relayUrl: "https://relay.example.test",
    });
  });
});
