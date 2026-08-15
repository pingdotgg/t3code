import { describe, expect, it } from "vite-plus/test";

import { rightPanelWidthStorageKey } from "./rightPanelWidthStorageKey";

describe("rightPanelWidthStorageKey", () => {
  it("gives two threads separate keys so one resize does not move the other", () => {
    const threadA = rightPanelWidthStorageKey("local/thread-a");
    const threadB = rightPanelWidthStorageKey("local/thread-b");

    expect(threadA).not.toBe(threadB);
  });

  it("returns the same key for the same thread so the width survives a reload", () => {
    expect(rightPanelWidthStorageKey("local/thread-a")).toBe(
      rightPanelWidthStorageKey("local/thread-a"),
    );
  });

  it("stays under the shared preview-panel prefix", () => {
    expect(rightPanelWidthStorageKey("local/thread-a")).toBe(
      "t3code:preview-panel-width:local/thread-a",
    );
  });
});
