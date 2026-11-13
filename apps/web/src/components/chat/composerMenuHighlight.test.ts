import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  it("clears the active result while async results are empty and resolves against restored results", () => {
    const search = {
      highlightedItemId: "second",
      currentSearchKey: "path:src",
      highlightedSearchKey: "path:src",
    };
    const cleared = resolveComposerMenuActiveItemId({ ...search, items: [] });
    expect(cleared).toBeNull();
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        highlightedItemId: cleared,
        items: [{ id: "new-result" }, { id: "second" }],
      }),
    ).toBe("new-result");
  });

  it("leaves a menu without an active row until the user highlights one", () => {
    const menu = {
      items: [{ id: "first" }, { id: "second" }],
      currentSearchKey: "folder:",
      highlightedSearchKey: "folder:",
      highlightFirst: false,
    };
    expect(resolveComposerMenuActiveItemId({ ...menu, highlightedItemId: null })).toBeNull();
    expect(resolveComposerMenuActiveItemId({ ...menu, highlightedItemId: "second" })).toBe(
      "second",
    );
    // A row picked for another query does not carry over.
    expect(
      resolveComposerMenuActiveItemId({
        ...menu,
        highlightedItemId: "second",
        highlightedSearchKey: "folder:s",
      }),
    ).toBeNull();
  });
});
