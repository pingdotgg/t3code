import { describe, expect, it } from "vite-plus/test";

import { resolveBrowserRecordingStopTarget } from "./browserRecordingScope";

describe("resolveBrowserRecordingStopTarget", () => {
  it("stops the active recording when no explicit tab was requested", () => {
    expect(resolveBrowserRecordingStopTarget("tab-a")).toBe("tab-a");
    expect(resolveBrowserRecordingStopTarget("tab-b")).toBe("tab-b");
    expect(resolveBrowserRecordingStopTarget(null)).toBeNull();
  });

  it("only stops an explicitly requested tab when it owns the recording", () => {
    expect(resolveBrowserRecordingStopTarget("tab-a", "tab-a")).toBe("tab-a");
    expect(resolveBrowserRecordingStopTarget("tab-a", "tab-b")).toBeNull();
  });
});
