import { describe, expect, it } from "vite-plus/test";
import { fitVerticalBarItems, type HeaderItem } from "./vertical-bar-items";

const files: HeaderItem = { type: "item", id: "files", title: "Files", onPress: () => {} };
const git: HeaderItem = {
  type: "item",
  id: "git",
  title: "Git",
  menu: { id: "git:menu", type: "menu", children: [] },
};
const filter: HeaderItem = {
  type: "item",
  id: "filter",
  menu: { id: "filter:menu", type: "menu", title: "Model filters", children: [] },
};
const search: HeaderItem = { type: "item", id: "search", searchBarPlacement: true };

describe("fitting a column's items into the Duo vertical bar", () => {
  it("folds the actions into More and keeps the search field when they do not fit", () => {
    const items = fitVerticalBarItems(
      [files, git, filter, { type: "spacer", id: "group", sizing: "fixed", width: 8 }, search],
      () => false,
    );
    expect(items.map((item) => item.id)).toEqual(["vertical-bar-more", "search"]);
    const more = items[0]!;
    expect(more.type === "item" && "menu" in more ? more.menu?.children : []).toEqual([
      expect.objectContaining({ id: "files:more", title: "Files", disabled: false }),
      expect.objectContaining({ id: "git:menu", title: "Git" }),
      expect.objectContaining({ id: "filter:menu", title: "Model filters" }),
    ]);
  });

  it("leaves the search field out of the bar's length", () => {
    const sizes: (readonly number[])[] = [];
    fitVerticalBarItems(
      [files, git, { type: "spacer", id: "group", sizing: "fixed", width: 8 }, search],
      (groupSizes) => {
        sizes.push(groupSizes);
        return true;
      },
    );
    expect(sizes).toEqual([[2, 0]]);
  });

  it("does not fold a single action into a menu", () => {
    const items = [files, search];
    expect(fitVerticalBarItems(items, () => false)).toBe(items);
  });
});
