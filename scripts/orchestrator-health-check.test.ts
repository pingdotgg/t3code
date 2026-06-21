import { describe, expect, it } from "vite-plus/test";

import {
  classifyBridgeStatus,
  defaultHealthCheckConfig,
  determineHealthAlert,
  parseEnvFileContents,
} from "./orchestrator-health-check.ts";

describe("orchestrator-health-check", () => {
  it("classifies unauthenticated bridge status codes", () => {
    expect(classifyBridgeStatus(401)).toEqual({
      ok: true,
      details: "bridge route exists and rejected unauthenticated request with 401",
    });
    expect(classifyBridgeStatus(503).details).toContain(
      "missing T3_EXECUTION_BRIDGE_SHARED_SECRET",
    );
    expect(classifyBridgeStatus(404).details).toContain("stale");
  });

  it("resolves defaults with env overrides", () => {
    const config = defaultHealthCheckConfig({
      T3CODE_HEALTH_LOCAL_BASE_URL: "http://localhost:4773",
      T3CODE_HEALTH_PUBLIC_BASE_URL: "https://example.com",
      T3CODE_HEALTH_EXTERNAL_INTAKE_PATH: "/custom-health",
      T3CODE_HEALTH_ALERT_URL: "https://alerts.example/health",
      T3_OPS_ALERT_SECRET: "ops-secret",
      T3CODE_HEALTH_NOTIFY: "1",
      T3CODE_HEALTH_ALERT_STATE_PATH: "tmp/health-state.json",
      T3CODE_HEALTH_SERVER_SERVICE: "custom-server",
      T3CODE_HEALTH_TUNNEL_SERVICE: "custom-tunnel",
      T3CODE_HEALTH_TIMEOUT_MS: "1234",
    });

    expect(config.timeoutMs).toBe(1234);
    expect(config.serverServiceName).toBe("custom-server");
    expect(config.tunnelServiceName).toBe("custom-tunnel");
    expect(config.notifyOnFailure).toBe(true);
    expect(config.alertSecret).toBe("ops-secret");
    expect(config.alertEndpointUrl).toBe("https://alerts.example/health");
    expect(config.externalIntakeHealthPath).toBe("/custom-health");
    expect(config.alertStatePath).toBe("tmp/health-state.json");
  });

  it("parses local env file values used by the CLI health check", () => {
    expect(
      parseEnvFileContents(`
# ignored
T3CODE_PUBLIC_BASE_URL=https://t3.example
T3CODE_HEALTH_EXTERNAL_INTAKE_PATH=/api/external-intake/health # local route
bad-line
`),
    ).toEqual([
      ["T3CODE_PUBLIC_BASE_URL", "https://t3.example"],
      ["T3CODE_HEALTH_EXTERNAL_INTAKE_PATH", "/api/external-intake/health"],
    ]);
  });

  it("alerts once on failure and once on recovery", () => {
    const passing = [{ name: "public T3", ok: true, details: "HTTP 200" }];
    const failing = [{ name: "public T3", ok: false, details: "HTTP 530" }];

    expect(determineHealthAlert({ previous: null, results: passing })).toBeNull();
    expect(determineHealthAlert({ previous: null, results: failing })).toBe("failing");
    expect(
      determineHealthAlert({
        previous: { status: "failing", updatedAt: "2026-05-15T00:00:00.000Z" },
        results: failing,
      }),
    ).toBeNull();
    expect(
      determineHealthAlert({
        previous: { status: "failing", updatedAt: "2026-05-15T00:00:00.000Z" },
        results: passing,
      }),
    ).toBe("recovered");
    expect(
      determineHealthAlert({
        previous: { status: "passing", updatedAt: "2026-05-15T00:00:00.000Z" },
        results: passing,
      }),
    ).toBeNull();
  });
});
