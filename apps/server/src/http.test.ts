import { describe, expect, it } from "vite-plus/test";

import {
  BrowserOtlpTraceCollectionError,
  BrowserOtlpTraceDecodeError,
  BrowserOtlpTraceExportError,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("browser OTLP diagnostics", () => {
  it("retains decode causes without retaining the trace payload", () => {
    const cause = new Error("private trace payload detail");
    const error = BrowserOtlpTraceDecodeError.fromPayload({ resourceSpans: [] }, cause);

    expect(error).toMatchObject({
      resourceSpanCount: 0,
      cause,
      message: "Failed to decode browser OTLP payload with 0 resource spans.",
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("bodyJson");
  });

  it("describes malformed trace payloads without inspecting unsafe fields", () => {
    const cause = new Error("private malformed trace payload detail");
    const error = BrowserOtlpTraceDecodeError.fromPayload(
      { resourceSpans: "private malformed resource spans" },
      cause,
    );

    expect(error).toMatchObject({
      resourceSpanCount: 0,
      cause,
      message: "Failed to decode browser OTLP payload with 0 resource spans.",
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("resourceSpans");
  });

  it("retains local collection causes with a structural record count", () => {
    const records = [{ type: "private trace record" }];
    const cause = new Error("private local collector detail");
    const error = BrowserOtlpTraceCollectionError.fromRecords(records, cause);

    expect(error).toMatchObject({
      recordCount: 1,
      cause,
      message: "Failed to collect 1 browser OTLP trace records locally.",
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("records");
  });

  it("redacts collector URL credentials while retaining the exact cause", () => {
    const collectorUrl =
      "https://collector-user:collector-password@traces.example.test/private/v1/traces?access_token=collector-secret#collector-fragment";
    const cause = new Error("collector transport failed");
    const error = BrowserOtlpTraceExportError.fromCollectorUrl(collectorUrl, cause);

    expect(error).toMatchObject({
      collectorUrlInputLength: collectorUrl.length,
      collectorUrlProtocol: "https:",
      collectorUrlHostname: "traces.example.test",
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("collectorUrl");
    for (const secret of [
      "collector-user",
      "collector-password",
      "/private/v1/traces",
      "collector-secret",
      "collector-fragment",
    ]) {
      expect(error.message).not.toContain(secret);
    }
  });
});
