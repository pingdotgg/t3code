import { describe, expect, it } from "vite-plus/test";

import {
  managedEndpointHostname,
  isManagedEndpointHostname,
  relayOwnsManagedEndpointZone,
  RELAY_WORKER_OBSERVABILITY,
} from "./deploymentConfig.ts";

describe("relay Worker observability", () => {
  it("records request URLs only through the relay's own redacting spans", () => {
    expect(RELAY_WORKER_OBSERVABILITY.logs).toEqual({
      enabled: true,
      invocationLogs: false,
      headSamplingRate: 0.01,
    });
  });
});

describe("relayOwnsManagedEndpointZone", () => {
  it("keeps the shared Cloudflare zone owned by production", () => {
    expect(relayOwnsManagedEndpointZone("prod")).toBe(true);
    expect(relayOwnsManagedEndpointZone("dev_julius")).toBe(false);
  });
});

describe("managed endpoint names", () => {
  it("keeps the DNS label within the provider limit for long stage names", () => {
    const hostname = managedEndpointHostname(
      "dev_" + "x".repeat(100),
      "example.com",
      "a".repeat(64),
    );

    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/-a{16}\.example\.com$/);
  });

  it("rejects hostnames outside the relay zone", () => {
    expect(isManagedEndpointHostname("internal.example.net", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("example.com.attacker.test", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("dev-julius.example.com.", "example.com")).toBe(false);
  });
});
