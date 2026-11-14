import { describe, expect, it } from "vite-plus/test";

import { formatDiagnosticsDuration } from "./DiagnosticsSettings.logic";

describe("formatDiagnosticsDuration", () => {
  it("prints durations that round up to a second in seconds", () => {
    expect([999.4, 999.6, 1_000].map(formatDiagnosticsDuration)).toEqual(["999 ms", "1 s", "1 s"]);
  });
});
