import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "~/session-logic";

import { selectComputerUseInProgress, selectLatestComputerUsePreview } from "./computerUsePreview";

const entry = (overrides: Partial<WorkLogEntry> & { id: string }): WorkLogEntry => ({
  createdAt: "2026-09-14T00:00:00.000Z",
  label: overrides.id,
  tone: "tool",
  ...overrides,
});

describe("selectLatestComputerUsePreview", () => {
  it("returns the newest computer-use capture with its app identity", () => {
    const preview = selectLatestComputerUsePreview([
      entry({
        id: "old",
        toolSurface: "computer",
        viewedImagePath: "/artifacts/computer-use-1.png",
        computerUseWindowTitle: "Inbox",
      }),
      entry({ id: "click", toolSurface: "computer", toolLifecycleStatus: "completed" }),
      entry({
        id: "new",
        toolSurface: "computer",
        viewedImagePath: "/artifacts/computer-use-2.png",
        computerUseWindowTitle: "December 2026",
        toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "com.apple.iCal" } },
        toolSource: { key: "native-app:com.apple.ical", name: "Calendar", kind: "computer" },
      }),
      entry({ id: "read", viewedImagePath: "/workspace/diagram.png" }),
    ]);
    expect(preview).toEqual({
      entryId: "new",
      imagePath: "/artifacts/computer-use-2.png",
      windowTitle: "December 2026",
      appIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "com.apple.iCal" } },
      appName: "Calendar",
    });
  });

  it("ignores threads without a capture", () => {
    expect(selectLatestComputerUsePreview([entry({ id: "a" })])).toBeNull();
    expect(
      selectLatestComputerUsePreview([entry({ id: "b", toolSurface: "computer" })]),
    ).toBeNull();
  });
});

describe("selectComputerUseInProgress", () => {
  it("reports the newest computer-use row's lifecycle", () => {
    const capture = entry({
      id: "capture",
      toolSurface: "computer",
      toolLifecycleStatus: "completed",
      viewedImagePath: "/artifacts/computer-use-1.png",
    });
    expect(selectComputerUseInProgress([capture])).toBe(false);
    expect(
      selectComputerUseInProgress([
        capture,
        entry({ id: "click", toolSurface: "computer", toolLifecycleStatus: "inProgress" }),
        entry({ id: "bash", toolLifecycleStatus: "inProgress" }),
      ]),
    ).toBe(true);
  });
});
