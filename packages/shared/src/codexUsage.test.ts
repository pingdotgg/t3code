import type { CodexUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { sortCodexUsageWindowsForDisplay } from "./codexUsage.ts";

function usageWindow(kind: CodexUsageWindow["kind"], remainingPercent: number): CodexUsageWindow {
  return {
    kind,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt: null,
    windowDurationMins: null,
  };
}

describe("sortCodexUsageWindowsForDisplay", () => {
  it("places the five-hour window before weekly usage", () => {
    const windows = [usageWindow("weekly", 80), usageWindow("five-hour", 40)];

    expect(sortCodexUsageWindowsForDisplay(windows).map((window) => window.kind)).toEqual([
      "five-hour",
      "weekly",
    ]);
    expect(windows.map((window) => window.kind)).toEqual(["weekly", "five-hour"]);
  });
});
