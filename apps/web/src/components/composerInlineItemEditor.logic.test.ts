import { describe, expect, it } from "vitest";

import { shouldRemoveCurrentInlineItemOnBackspace } from "./composerInlineItemEditor.logic";

describe("shouldRemoveCurrentInlineItemOnBackspace", () => {
  it("does not remove the current inline item when the caret is at offset 0", () => {
    expect(shouldRemoveCurrentInlineItemOnBackspace(0)).toBe(false);
  });

  it("removes the current inline item when the caret is after the token", () => {
    expect(shouldRemoveCurrentInlineItemOnBackspace(1)).toBe(true);
  });
});
