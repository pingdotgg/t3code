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

  it("leaves a bare machine list without an active item until the user highlights one", () => {
    const input = {
      items: [{ id: "machine-a" }, { id: "machine-b" }],
      currentSearchKey: "environment:",
      highlightedSearchKey: "environment:",
      explicitOnly: true,
    };
    expect(resolveComposerMenuActiveItemId({ ...input, highlightedItemId: null })).toBeNull();
    expect(resolveComposerMenuActiveItemId({ ...input, highlightedItemId: "machine-b" })).toBe(
      "machine-b",
    );
  });
});
