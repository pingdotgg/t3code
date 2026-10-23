import { describe, expect, it } from "vite-plus/test";

import { hashTelemetryId, isTelemetryIdHash } from "./telemetryId.ts";

describe("telemetry ids", () => {
  it("accepts only hashes, never a raw id", () => {
    expect(isTelemetryIdHash(hashTelemetryId("user_connect"))).toBe(true);
    expect(isTelemetryIdHash("user_connect")).toBe(false);
    expect(isTelemetryIdHash(hashTelemetryId("x").toUpperCase())).toBe(false);
  });
});
