import { describe, expect, it } from "vite-plus/test";

import { resolveBrowserRecordingStopTarget } from "./browserRecordingScope";

describe("resolveBrowserRecordingStopTarget", () => {
  it("stops the active recording even after the requested tab changes", () => {
    expect(resolveBrowserRecordingStopTarget("tab-a")).toBe("tab-a");
    expect(resolveBrowserRecordingStopTarget("tab-b")).toBe("tab-b");
    expect(resolveBrowserRecordingStopTarget(null)).toBeNull();
  });
});
