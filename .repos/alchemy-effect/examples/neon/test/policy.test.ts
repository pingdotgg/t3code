import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  corsHeaders,
  MAX_BYTES,
  objectKey,
  parseUpload,
  serializeUploadRow,
  UUID,
} from "../src/policy.ts";

describe("upload response serialization", () => {
  for (const actualBytes of [null, 0n, 35n, 9007199254740993n]) {
    test(`encodes Postgres bigint metadata with actual bytes ${actualBytes}`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const row = yield* Effect.sync(() =>
            serializeUploadRow({
              id: "10000000-0000-4000-8000-000000000001",
              filename: "report.txt",
              object_key: "incoming/owner/file-id",
              content_type: "text/plain",
              expected_bytes: 35n,
              actual_bytes: actualBytes,
              status: actualBytes === null ? "awaiting_upload" : "ready",
              created_at: Date.parse("2026-09-17T00:00:00.000Z"),
            }),
          );
          const response = yield* HttpServerResponse.json([row]);
          expect(response.status).toBe(200);
          expect(row.expected_bytes).toBe("35");
          expect(row.actual_bytes).toBe(actualBytes?.toString() ?? null);
          expect(row.created_at).toBe("2026-09-17T00:00:00.000Z");
        }),
      ));
  }
});

describe("upload request policy", () => {
  test("accepts valid metadata at the size limit", () => {
    expect(
      parseUpload({
        filename: "report.txt",
        contentType: "text/plain",
        size: MAX_BYTES,
      }),
    ).toEqual({
      filename: "report.txt",
      contentType: "text/plain",
      size: MAX_BYTES,
    });
  });
  test("rejects empty, oversized, fractional and nonnumeric sizes", () => {
    for (const size of [0, -1, MAX_BYTES + 1, 0.5, "1", null, Infinity]) {
      expect(
        parseUpload({
          filename: "report.txt",
          contentType: "text/plain",
          size,
        }),
      ).toBeUndefined();
    }
  });
  test("rejects malformed metadata", () => {
    for (const value of [
      null,
      [],
      "file",
      {},
      { filename: "x", size: 1 },
      { filename: "\r\n", contentType: "text/plain", size: 1 },
      { filename: "x", contentType: "text/plain\r\nx-header: bad", size: 1 },
    ]) {
      expect(parseUpload(value)).toBeUndefined();
    }
  });
  test("encodes owner path segments and never uses the filename in keys", () => {
    expect(objectKey("user/../../other", "file-id")).toBe(
      "incoming/user%2F..%2F..%2Fother/file-id",
    );
  });
  test("normalizes deployed URLs with trailing slashes", () => {
    expect(
      corsHeaders("https://app.example", "https://app.example/")?.[
        "access-control-allow-origin"
      ],
    ).toBe("https://app.example");
    expect(corsHeaders("null", "not-a-url")).toBeUndefined();
  });
  test("allows explicitly configured wildcard CORS without cookies", () => {
    const headers = corsHeaders("https://app.example", "*");
    expect(headers?.["access-control-allow-origin"]).toBe("*");
    expect(headers?.["access-control-allow-credentials"]).toBeUndefined();
  });
  test("rejects unexpected origins", () => {
    expect(
      corsHeaders("https://attacker.example", "https://app.example"),
    ).toBeUndefined();
    expect(corsHeaders("https://app.example", undefined)).toBeUndefined();
  });
  test("permits the configured browser origin without credentials", () => {
    const headers = corsHeaders("https://app.example", "https://app.example");
    expect(headers?.["access-control-allow-origin"]).toBe(
      "https://app.example",
    );
    expect(headers?.["access-control-allow-credentials"]).toBeUndefined();
    expect(headers?.vary).toBe("Origin");
  });
  test("permits nonbrowser requests but does not manufacture an origin", () => {
    expect(
      corsHeaders(null, "https://app.example")?.["access-control-allow-origin"],
    ).toBeUndefined();
  });
  test("validates download IDs before the uuid query", () => {
    expect(UUID.test("10000000-0000-4000-8000-000000000001")).toBe(true);
    expect(UUID.test("../another-user")).toBe(false);
  });
});
