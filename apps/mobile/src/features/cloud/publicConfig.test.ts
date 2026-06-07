import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasMobileTracingPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCloudPublicConfig", () => {
  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
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
      clerkPublishableKey: "pk_test_example",
      clerkJwtTemplate: "t3-relay",
      relayUrl: "https://relay.example.test",
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
      clerkPublishableKey: "pk_test_example",
      clerkJwtTemplate: "t3-relay",
      relayUrl: null,
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

  it("falls back to Expo public tracing variables when manifest extra is absent", () => {
    vi.stubEnv("EXPO_PUBLIC_T3CODE_MOBILE_OTLP_TRACES_URL", "https://api.axiom.co/v1/traces");
    vi.stubEnv("EXPO_PUBLIC_T3CODE_MOBILE_OTLP_TRACES_DATASET", "mobile-traces");
    vi.stubEnv("EXPO_PUBLIC_T3CODE_MOBILE_OTLP_TRACES_TOKEN", "public-ingest-token");

    expect(resolveCloudPublicConfig({}).observability).toEqual({
      tracesUrl: "https://api.axiom.co/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("keeps tracing disabled unless every public tracing value is configured", () => {
    expect(hasMobileTracingPublicConfig(resolveCloudPublicConfig({}))).toBe(false);
    expect(
      hasMobileTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasMobileTracingPublicConfig(
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
