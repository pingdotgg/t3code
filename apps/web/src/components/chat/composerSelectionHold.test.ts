import { describe, expect, it } from "vite-plus/test";

import { selectionHoldsComposerOpen } from "./composerSelectionHold";

function node(parent: Node | null = null) {
  const self = {
    parent,
    contains(other: Node | null): boolean {
      let cursor: { parent: Node | null } | null = other as unknown as { parent: Node | null };
      while (cursor) {
        if (cursor === (self as unknown)) return true;
        cursor = cursor.parent as { parent: Node | null } | null;
      }
      return false;
    },
  };
  return self as unknown as Node;
}

function selection(anchor: Node, collapsed = false) {
  return {
    isCollapsed: collapsed,
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: anchor }) as Range,
  };
}

describe("selectionHoldsComposerOpen", () => {
  const timeline = node();
  const message = node(timeline);
  const elsewhere = node();

  it("holds for a range inside the timeline", () => {
    expect(selectionHoldsComposerOpen(selection(message), timeline)).toBe(true);
  });

  it("ignores a caret with nothing selected", () => {
    expect(selectionHoldsComposerOpen(selection(message, true), timeline)).toBe(false);
  });

  it("ignores selections outside the timeline", () => {
    expect(selectionHoldsComposerOpen(selection(elsewhere), timeline)).toBe(false);
  });

  it("ignores an empty or missing selection", () => {
    expect(selectionHoldsComposerOpen(null, timeline)).toBe(false);
    expect(
      selectionHoldsComposerOpen(
        { isCollapsed: false, rangeCount: 0, getRangeAt: () => ({}) as Range },
        timeline,
      ),
    ).toBe(false);
    expect(selectionHoldsComposerOpen(selection(message), null)).toBe(false);
  });
});
