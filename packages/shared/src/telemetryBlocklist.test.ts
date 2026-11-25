import { describe, expect, it } from "vite-plus/test";

import { BLOCKED_TELEMETRY_URL_PATTERNS, isBlockedTelemetryHost } from "./telemetryBlocklist.ts";

describe("isBlockedTelemetryHost", () => {
  it.each([
    "ingest.t3.codes",
    "app.t3.codes",
    "t3.codes",
    "INGEST.T3.CODES.",
    "us.i.posthog.com",
    "posthog.com",
    "api.axiom.co",
  ])("blocks %s", (host) => expect(isBlockedTelemetryHost(host)).toBe(true));

  it.each(["notposthog.com", "t3.codes.example.com", "axiom.co.example.com", "github.com"])(
    "allows %s",
    (host) => expect(isBlockedTelemetryHost(host)).toBe(false),
  );
});

describe("BLOCKED_TELEMETRY_URL_PATTERNS", () => {
  it("covers the bare and subdomain form of each host over every scheme", () => {
    expect(BLOCKED_TELEMETRY_URL_PATTERNS).toContain("https://*.t3.codes/*");
    expect(BLOCKED_TELEMETRY_URL_PATTERNS).toContain("wss://*.posthog.com/*");
    expect(BLOCKED_TELEMETRY_URL_PATTERNS).toHaveLength(3 * 4 * 2);
  });
});
