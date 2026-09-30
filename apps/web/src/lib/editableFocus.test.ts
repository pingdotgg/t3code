import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { editableOwnsUndo } from "./editableFocus";

// The unit project has no DOM; these stand in for the elements the helper inspects.
class FakeElement extends EventTarget {
  constructor(
    readonly editable: boolean,
    readonly textContent = "",
  ) {
    super();
  }
  closest() {
    return this.editable ? this : null;
  }
}
class FakeInput extends FakeElement {
  constructor(readonly value: string) {
    super(true);
  }
}

class FakeTextArea extends FakeInput {}

beforeEach(() => {
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
});
afterEach(() => vi.unstubAllGlobals());

describe("editableOwnsUndo", () => {
  it("yields to native undo only when the focused field has text", () => {
    expect(editableOwnsUndo(new FakeInput(""))).toBe(false);
    expect(editableOwnsUndo(new FakeInput("draft"))).toBe(true);
    expect(editableOwnsUndo(new FakeElement(true, ""))).toBe(false);
    expect(editableOwnsUndo(new FakeElement(true, "draft"))).toBe(true);
  });

  it("ignores non-editable targets", () => {
    expect(editableOwnsUndo(new FakeElement(false, "Undo"))).toBe(false);
    expect(editableOwnsUndo(null)).toBe(false);
  });
});
