import { describe, expect, it } from "vite-plus/test";

import { diskChange, staleAfterSave } from "./WorkflowDefinitionEditor.logic";

describe("diskChange", () => {
  it.each([
    [
      "a clean editor follows the file",
      { source: "B", baseline: "A", dirty: false, saving: null },
      "follow",
    ],
    [
      "edits over a change are stale",
      { source: "B", baseline: "A", dirty: true, saving: null },
      "stale",
    ],
    [
      "the file it already holds is nothing",
      { source: "A", baseline: "A", dirty: true, saving: null },
      "ignore",
    ],
    [
      "the save's own text is nothing",
      { source: "C", baseline: "A", dirty: true, saving: "C" },
      "ignore",
    ],
    // The disk went A → B → A while C was being saved: back at the baseline, but not what was saved.
    [
      "a change back to the baseline during a save is stale",
      { source: "A", baseline: "A", dirty: true, saving: "C" },
      "stale",
    ],
  ] as const)("%s", (_, input, expected) => {
    expect(diskChange(input)).toBe(expected);
  });
});

describe("staleAfterSave", () => {
  it("settles the change the person saved over and keeps a newer one", () => {
    const b = { source: "B" };
    expect(staleAfterSave(b, b)).toBeNull();
    const a = { source: "A" };
    expect(staleAfterSave(a, b)).toBe(a);
    expect(staleAfterSave(a, null)).toBe(a);
    // The disk went B → A → B while the save was out: back at the same text, but a change of its own.
    const bAgain = { source: "B" };
    expect(staleAfterSave(bAgain, b)).toBe(bAgain);
  });
});
