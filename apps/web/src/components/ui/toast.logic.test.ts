import { assert, describe, it } from "vitest";
import { shouldHideCollapsedToastContent } from "./toast.logic";

describe("shouldHideCollapsedToastContent", () => {
  it("keeps a single visible toast readable", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 1), false);
  });

  it("keeps the front-most toast readable in a visible stack", () => {
    assert.equal(shouldHideCollapsedToastContent(0, 3), false);
  });

  it("hides non-front toasts until the stack is expanded", () => {
    assert.equal(shouldHideCollapsedToastContent(1, 3), true);
  });
});
