import { describe, expect, it } from "vite-plus/test";

import { didComposerSelectionChangeVisibly } from "./composerSelection";

describe("didComposerSelectionChangeVisibly", () => {
  it("ignores selection-neutral editor updates", () => {
    expect(didComposerSelectionChangeVisibly({ start: 3, end: 3 }, null)).toBe(false);
    expect(didComposerSelectionChangeVisibly({ start: 3, end: 3 }, { start: 3, end: 3 })).toBe(
      false,
    );
  });

  it("detects entering and extending a visible range selection", () => {
    expect(didComposerSelectionChangeVisibly({ start: 3, end: 3 }, { start: 0, end: 3 })).toBe(
      true,
    );
    expect(didComposerSelectionChangeVisibly({ start: 1, end: 3 }, { start: 0, end: 3 })).toBe(
      true,
    );
  });

  it("does not repeatedly report the same visible selection", () => {
    expect(didComposerSelectionChangeVisibly({ start: 0, end: 3 }, { start: 0, end: 3 })).toBe(
      false,
    );
  });
});
