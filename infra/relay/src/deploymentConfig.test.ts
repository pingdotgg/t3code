import { describe, expect, it } from "vitest";

import {
  managedEndpointDigestInput,
  managedEndpointHostname,
  managedEndpointTunnelName,
  relayPublicDomainForStage,
  relayResourceNameForStage,
  relayStageSlug,
} from "./deploymentConfig.ts";

describe("relayStageSlug", () => {
  it("matches Alchemy physical-name sanitization for default developer stages", () => {
    expect(relayStageSlug("dev_julius")).toBe("dev-julius");
  });
});

describe("relayPublicDomainForStage", () => {
  it("uses the canonical relay hostname for production", () => {
    expect(relayPublicDomainForStage("prod", ".example.com.")).toBe("relay.example.com");
  });

  it("isolates personal stages below the imported zone", () => {
    expect(relayPublicDomainForStage("dev_julius", "example.com")).toBe(
      "relay-dev-julius.example.com",
    );
  });
});

describe("relayResourceNameForStage", () => {
  it("isolates production and personal stages", () => {
    expect(relayResourceNameForStage("t3-code-relay-traces", "prod")).toBe(
      "t3-code-relay-traces-prod",
    );
    expect(relayResourceNameForStage("t3-code-relay-traces", "dev_julius")).toBe(
      "t3-code-relay-traces-dev-julius",
    );
  });
});

describe("managed endpoint names", () => {
  it("uses the stage slug and a stable stage-scoped digest suffix", () => {
    const hash = "ABCDEF0123456789ABCDEF0123456789";

    expect(managedEndpointDigestInput("dev_julius", "env_123")).toBe("dev_julius:env_123");
    expect(managedEndpointHostname("dev_julius", ".example.com.", hash)).toBe(
      "tunnels-dev-julius-abcdef0123456789.example.com",
    );
    expect(managedEndpointTunnelName("dev_julius", hash)).toBe(
      "t3coderelay-managedendpoint-dev-julius-abcdef0123456789",
    );
  });

  it("keeps the DNS label within the provider limit for long stage names", () => {
    const hostname = managedEndpointHostname(
      "dev_" + "x".repeat(100),
      "example.com",
      "a".repeat(64),
    );

    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/-a{16}\.example\.com$/);
  });
});
