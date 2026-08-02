import { describe, expect, it } from "vite-plus/test";

import {
  resolveBrowserRecordingStopTarget,
  rewriteBrowserRecordingArtifactTabId,
} from "./browserRecordingScope";

describe("resolveBrowserRecordingStopTarget", () => {
  const active = { runtimeTabId: "runtime-a", serverTabId: "tab-a" };

  it("uses the implicit server tab when multiple recordings are active", () => {
    const other = { runtimeTabId: "runtime-b", serverTabId: "tab-b" };
    expect(resolveBrowserRecordingStopTarget([active, other], "tab-b")).toEqual(other);
    expect(resolveBrowserRecordingStopTarget([active, other], null)).toBeNull();
    expect(resolveBrowserRecordingStopTarget([active], null)).toEqual(active);
    expect(resolveBrowserRecordingStopTarget([], null)).toBeNull();
  });

  it("only stops an explicitly requested runtime when it owns the recording", () => {
    expect(resolveBrowserRecordingStopTarget([active], "tab-a", "runtime-a")).toEqual(active);
    expect(resolveBrowserRecordingStopTarget([active], "tab-a", "runtime-b")).toBeNull();
  });

  it("does not authorize another runtime that reuses the server tab id", () => {
    expect(
      resolveBrowserRecordingStopTarget(
        [{ runtimeTabId: "environment-a:epoch-a:tab-1", serverTabId: "tab-1" }],
        "tab-1",
        "environment-b:epoch-b:tab-1",
      ),
    ).toBeNull();
  });

  it("maps saved runtime-keyed artifacts back to their server tab id", () => {
    expect(
      rewriteBrowserRecordingArtifactTabId(
        {
          id: "recording-1",
          tabId: '["environment-1","thread-1","epoch-1","tab-1"]',
          path: "/tmp/recording.mp4",
        },
        { runtimeTabId: '["environment-1","thread-1","epoch-1","tab-1"]', serverTabId: "tab-1" },
      ),
    ).toEqual({
      id: "recording-1",
      tabId: "tab-1",
      path: "/tmp/recording.mp4",
    });
  });
});
