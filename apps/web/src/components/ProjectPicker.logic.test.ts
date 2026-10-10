import { describe, expect, it } from "vite-plus/test";

import { filterProjectPickerItems, reduceProjectPickerMenuState } from "./ProjectPicker.logic";

describe("filterProjectPickerItems", () => {
  const items = [
    { value: "all", label: "All projects", hideWhileSearching: true },
    { value: "alpha", label: "Alpha workspace" },
    { value: "beta", label: "Beta tools" },
  ] as const;
  const filter = (query: string) =>
    filterProjectPickerItems({
      items,
      query,
      matches: (item, candidate) =>
        item.label.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()),
    });

  it("shows every row while the query is empty", () => {
    expect(filter("")).toEqual(items);
    expect(filter("   ")).toEqual(items);
  });

  it("hides non-project rows while filtering", () => {
    expect(filter("all")).toEqual([]);
  });

  it("returns matching projects in source order and supports no-match results", () => {
    expect(filter("WORK")).toEqual([items[1]]);
    expect(filter("missing")).toEqual([]);
  });
});

describe("reduceProjectPickerMenuState", () => {
  const queriedOpenState = { open: true, query: "alpha" };

  it("clears the query when the combobox closes through onOpenChange", () => {
    expect(
      reduceProjectPickerMenuState(queriedOpenState, { type: "open-changed", open: false }),
    ).toEqual({ open: false, query: "" });
  });

  it("clears the query when project settings closes the combobox", () => {
    expect(
      reduceProjectPickerMenuState(queriedOpenState, { type: "project-settings-opened" }),
    ).toEqual({ open: false, query: "" });
  });

  it("keeps the popup open while the query changes", () => {
    expect(
      reduceProjectPickerMenuState(
        { open: true, query: "" },
        { type: "query-changed", query: "beta" },
      ),
    ).toEqual({ open: true, query: "beta" });
  });
});
