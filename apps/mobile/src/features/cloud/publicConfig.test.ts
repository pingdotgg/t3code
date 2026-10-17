import { describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  BackgroundRelayUrlInvalidError,
  hasTracingPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("normalizes an independent background relay without changing T3 Connect", () => {
    expect(
      resolveCloudPublicConfig({
        relay: {
          url: "https://relay.example.test",
          backgroundUrl: " https://background.example.test/// ",
        },
      }).relay,
    ).toEqual({
      url: "https://relay.example.test",
      backgroundUrl: "https://background.example.test",
    });
  });

  it.each([
    "http://background.example.test",
    "https://user:secret@background.example.test",
    "https://background.example.test/path",
    "not a URL",
  ])(
    "rejects invalid background configuration instead of silently using the primary relay: %s",
    (backgroundUrl) => {
      expect(() => resolveCloudPublicConfig({ relay: { backgroundUrl } })).toThrow(
        BackgroundRelayUrlInvalidError,
      );
    },
  );
  it("reports the missing Clerk JWT template as structured configuration", () => {
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });

  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      clerk: {
        publishableKey: null,
        jwtTemplate: null,
      },
      relay: {
        url: null,
        backgroundUrl: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  ", jwtTemplate: "  t3-relay  " },
        relay: { url: " https://relay.example.test/// " },
        observability: {
          tracesUrl: " https://api.axiom.co/v1/traces ",
          tracesDataset: " mobile-traces ",
          tracesToken: " public-ingest-token ",
        },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: "https://relay.example.test",
        backgroundUrl: null,
      },
      observability: {
        tracesUrl: "https://api.axiom.co/v1/traces",
        tracesDataset: "mobile-traces",
        tracesToken: "public-ingest-token",
      },
    });
  });

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
      relay: {
        url: null,
        backgroundUrl: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("rejects an insecure traces URL", () => {
    expect(
      resolveCloudPublicConfig({
        observability: {
          tracesUrl: "http://api.axiom.co/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      }).observability,
    ).toEqual({
      tracesUrl: null,
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("keeps tracing disabled unless every public tracing value is configured", () => {
    expect(hasTracingPublicConfig(resolveCloudPublicConfig({}))).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
            tracesToken: "public-ingest-token",
          },
        }),
      ),
    ).toBe(true);
  });
});
