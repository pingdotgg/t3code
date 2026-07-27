import { describe, expect, it } from "vite-plus/test";

import { resolveBrowserRecordingStopTarget } from "./browserRecordingScope";

describe("resolveBrowserRecordingStopTarget", () => {
  it("stops the only active recording when the implicit browser target changed", () => {
    expect(resolveBrowserRecordingStopTarget(new Set(["tab-recording"]), "tab-browsing")).toBe(
      "tab-recording",
    );
  });

  it("prefers an implicit target that is actively recording", () => {
    expect(
      resolveBrowserRecordingStopTarget(
        new Set(["tab-recording-a", "tab-recording-b"]),
        "tab-recording-b",
      ),
    ).toBe("tab-recording-b");
  });

  it("does not guess when multiple recordings are active and the implicit target is not one", () => {
    expect(
      resolveBrowserRecordingStopTarget(
        new Set(["tab-recording-a", "tab-recording-b"]),
        "tab-browsing",
      ),
    ).toBeNull();
  });

  it("only stops an explicitly requested tab when that tab is recording", () => {
    const activeTabIds = new Set(["tab-recording"]);
    expect(resolveBrowserRecordingStopTarget(activeTabIds, "tab-browsing", "tab-recording")).toBe(
      "tab-recording",
    );
    expect(resolveBrowserRecordingStopTarget(activeTabIds, "tab-recording", "tab-browsing")).toBe(
      null,
    );
  });

  it("returns null when no matching recording is active", () => {
    expect(resolveBrowserRecordingStopTarget(new Set(), "tab-browsing")).toBeNull();
  });
});
