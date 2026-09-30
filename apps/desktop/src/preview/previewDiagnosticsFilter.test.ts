import { describe, expect, it } from "vite-plus/test";

import { isBenignAbortedTraceExport } from "./previewDiagnosticsFilter.ts";

describe("isBenignAbortedTraceExport", () => {
  it("ignores an aborted export to the client telemetry endpoint", () => {
    expect(
      isBenignAbortedTraceExport({
        url: "http://127.0.0.1:6952/api/observability/v1/traces",
        errorText: "net::ERR_ABORTED",
      }),
    ).toBe(true);
  });

  it("keeps a non-abort failure of the telemetry endpoint", () => {
    expect(
      isBenignAbortedTraceExport({
        url: "http://127.0.0.1:6952/api/observability/v1/traces",
        errorText: "net::ERR_CONNECTION_REFUSED",
      }),
    ).toBe(false);
  });

  it("keeps an aborted request to any other endpoint", () => {
    expect(
      isBenignAbortedTraceExport({
        url: "http://127.0.0.1:6952/api/auth/session",
        errorText: "net::ERR_ABORTED",
      }),
    ).toBe(false);
  });

  it("keeps an aborted request whose URL cannot be parsed", () => {
    expect(isBenignAbortedTraceExport({ url: "not a url", errorText: "net::ERR_ABORTED" })).toBe(
      false,
    );
  });
});
