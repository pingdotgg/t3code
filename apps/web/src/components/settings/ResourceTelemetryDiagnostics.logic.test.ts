import { describe, expect, it } from "vite-plus/test";

import { shouldShowResourceMonitorRetry } from "./ResourceTelemetryDiagnostics.logic";

describe("shouldShowResourceMonitorRetry", () => {
  it("allows retry when the initial telemetry request fails before a snapshot", () => {
    expect(
      shouldShowResourceMonitorRetry({
        nativeStatus: null,
        error: "Resource monitor is unavailable.",
      }),
    ).toBe(true);
  });

  it("does not show retry for an initial load without an error or a healthy snapshot", () => {
    expect(shouldShowResourceMonitorRetry({ nativeStatus: null, error: null })).toBe(false);
    expect(shouldShowResourceMonitorRetry({ nativeStatus: "healthy", error: null })).toBe(false);
  });
});
