import { describe, expect, it } from "vite-plus/test";

import {
  formatRunningSubagentDuration,
  formatTerminalSubagentStatusDuration,
  subagentDurationFallbackLabel,
} from "./subagentDisplay";

describe("subagentDurationFallbackLabel", () => {
  it("does not report terminal subagents without completion time as completed", () => {
    expect(subagentDurationFallbackLabel("completed")).toBe("duration unknown");
    expect(subagentDurationFallbackLabel("errored")).toBe("duration unknown");
    expect(subagentDurationFallbackLabel("interrupted")).toBe("duration unknown");
    expect(subagentDurationFallbackLabel("stopped")).toBe("duration unknown");
  });

  it("keeps distinct fallback labels for running and unknown relations", () => {
    expect(subagentDurationFallbackLabel("running")).toBe("Working");
    expect(subagentDurationFallbackLabel(null)).toBe("status unknown");
  });
});

describe("formatRunningSubagentDuration", () => {
  it("uses working wording for active subagents", () => {
    expect(formatRunningSubagentDuration(new Date().toISOString())).toMatch(/^Working( for .+)?$/);
  });
});

describe("formatTerminalSubagentStatusDuration", () => {
  it("formats successful completion as completed in duration", () => {
    expect(formatTerminalSubagentStatusDuration("completed", "5s")).toBe("Completed in 5s");
  });
});
