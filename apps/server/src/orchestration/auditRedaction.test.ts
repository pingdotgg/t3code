import { describe, expect, it } from "vitest";

import { redactAuditPayload, redactAuditText, redactSensitiveValues } from "./auditRedaction.ts";

describe("audit redaction", () => {
  it("bounds truncated previews by UTF-8 bytes without splitting characters", () => {
    const result = redactAuditPayload("🙂".repeat(32 * 1024));

    expect(result.evidenceStatus).toBe("truncated");
    expect(result.payload).toMatchObject({ truncated: true });
    if (
      result.payload === null ||
      typeof result.payload !== "object" ||
      !("preview" in result.payload) ||
      typeof result.payload.preview !== "string"
    ) {
      throw new Error("Expected a truncated audit preview.");
    }
    expect(Buffer.byteLength(result.payload.preview, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.payload.preview).not.toContain("\uFFFD");
  });

  it("projects truncated cleanup errors to a schema-safe string", () => {
    const error = redactAuditText("界".repeat(64 * 1024));

    expect(typeof error).toBe("string");
    expect(Buffer.byteLength(error, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(error).not.toContain("\uFFFD");
  });

  it("redacts credentials embedded in Git remotes and http.extraheader arguments", () => {
    const credentials = [
      "https://live-token:another-secret@github.com/owner/repo.git",
      "-c",
      "http.extraheader=Authorization: Basic c2VjcmV0",
      "--config=http.extraheader=Authorization: Bearer live-bearer-token",
    ];

    const result = redactSensitiveValues(credentials);
    const serialized = JSON.stringify(result.payload);

    expect(result.redacted).toBe(true);
    expect(serialized).not.toContain("live-token");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("c2VjcmV0");
    expect(serialized).not.toContain("live-bearer-token");
  });
});
