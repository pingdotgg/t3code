import { describe, expect, it } from "vite-plus/test";

import { hashTelemetryId, isTelemetryIdHash } from "./telemetryId.ts";

describe("telemetry ids", () => {
  // The server hashes the linked Connect account and clients hash the signed-in
  // one. Both must give plain SHA-256 hex, or the two never match.
  it("is the SHA-256 hex digest of the id", () => {
    expect(hashTelemetryId("user_connect")).toBe(
      "7938265611170ce1ba814a67f5a51bcff2b9b46c5597da465e6f098f2217717a",
    );
  });

  it("accepts only hashes, never a raw id", () => {
    expect(isTelemetryIdHash(hashTelemetryId("user_connect"))).toBe(true);
    expect(isTelemetryIdHash("user_connect")).toBe(false);
    expect(isTelemetryIdHash(hashTelemetryId("x").toUpperCase())).toBe(false);
  });
});
