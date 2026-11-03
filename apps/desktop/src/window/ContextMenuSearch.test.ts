import { expect, it } from "vite-plus/test";
import { contextMenuWebSearch } from "./ContextMenuSearch.ts";

it.each(["", "   ", "\n\t "])("offers no search for a blank selection %j", (selection) => {
  expect(contextMenuWebSearch(selection)).toBeUndefined();
});

it("searches the whole selection with collapsed whitespace and a shortened label", () => {
  const search = contextMenuWebSearch("  effect   schema\n decode & encode helpers for contracts ");
  expect(search?.url).toBe(
    "https://www.google.com/search?q=effect%20schema%20decode%20%26%20encode%20helpers%20for%20contracts",
  );
  expect(search?.label).toBe("Search Google for “effect schema decode && encode…”");
});
