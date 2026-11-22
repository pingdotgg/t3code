import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import {
  latestTurnChangedFileCount,
  rightPanelDynamicTabSurfaces,
  rightPanelSectionOf,
  rightPanelSectionTarget,
} from "./RightPanelTabs.logic";

const diff: RightPanelSurface = { id: "diff", kind: "diff" };
const firstTerminal = {
  id: "terminal:a",
  kind: "terminal",
  terminalIds: ["a"],
  activeTerminalId: "a",
} as unknown as RightPanelSurface;
const secondTerminal = {
  id: "terminal:b",
  kind: "terminal",
  terminalIds: ["b"],
  activeTerminalId: "b",
} as unknown as RightPanelSurface;
const browser: RightPanelSurface = { id: "browser:tab", kind: "preview", resourceId: "tab" };
const files = { id: "files", kind: "files" } as unknown as RightPanelSurface;

describe("right panel sections", () => {
  const surfaces = [diff, firstTerminal, files, secondTerminal, browser];

  it("maps diff, terminal and browser surfaces to their section", () => {
    expect(rightPanelSectionOf(diff)).toBe("changes");
    expect(rightPanelSectionOf(secondTerminal)).toBe("terminal");
    expect(rightPanelSectionOf(browser)).toBe("browser");
    expect(rightPanelSectionOf(files)).toBeNull();
    expect(rightPanelSectionOf(undefined)).toBeNull();
  });

  it("keeps the active surface when it already belongs to the section", () => {
    expect(rightPanelSectionTarget(surfaces, "terminal:a", "terminal")).toBe(firstTerminal);
  });

  it("falls back to the newest surface of the section's kind", () => {
    expect(rightPanelSectionTarget(surfaces, "files", "terminal")).toBe(secondTerminal);
    expect(rightPanelSectionTarget(surfaces, null, "changes")).toBe(diff);
  });

  it("asks for a new surface when the section has none, so a click never adds a second one", () => {
    expect(rightPanelSectionTarget([diff, files], "diff", "browser")).toBeNull();
    expect(rightPanelSectionTarget([files], "files", "terminal")).toBeNull();
  });

  it("drops only the diff from the dynamic tabs", () => {
    expect(rightPanelDynamicTabSurfaces(surfaces)).toEqual([
      firstTerminal,
      files,
      secondTerminal,
      browser,
    ]);
  });
});

function summary(
  checkpointTurnCount: number,
  fileCount: number,
  filesTotal?: number,
): ThreadCheckpointSummary {
  return {
    checkpointTurnCount,
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `f${index}`,
      kind: "modified",
      additions: 1,
      deletions: 0,
    })),
    ...(filesTotal === undefined
      ? {}
      : { filesTotal: { count: filesTotal, additions: 0, deletions: 0 } }),
  } as unknown as ThreadCheckpointSummary;
}

describe("latestTurnChangedFileCount", () => {
  it("counts the files of the highest turn, whatever the order", () => {
    expect(latestTurnChangedFileCount([summary(2, 3), summary(1, 7)])).toBe(3);
    expect(latestTurnChangedFileCount([summary(1, 7), summary(2, 3)])).toBe(3);
  });

  it("uses the server total when the file list is only a prefix", () => {
    expect(latestTurnChangedFileCount([summary(1, 2, 40)])).toBe(40);
  });

  it("has no count before the first turn", () => {
    expect(latestTurnChangedFileCount([])).toBeNull();
  });
});
