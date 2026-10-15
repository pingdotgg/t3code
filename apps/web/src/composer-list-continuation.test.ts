import { describe, expect, it } from "vite-plus/test";

import {
  listContinuationForEnter,
  listIndentForTab,
  nextOrderedMarkerText,
} from "./composer-list-continuation";

function applyEdit(value: string, edit: { start: number; end: number; replacement: string }) {
  return value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
}

describe("composer list continuation", () => {
  it("continues ordered lists with the next number", () => {
    const value = "1. foo";
    const edit = listContinuationForEnter(value, value.length);
    expect(edit).not.toBeNull();
    expect(applyEdit(value, edit!)).toBe("1. foo\n2. ");
  });

  it("increments multi-digit and paren markers", () => {
    expect(applyEdit("12. foo", listContinuationForEnter("12. foo", 7)!)).toBe("12. foo\n13. ");
    expect(applyEdit("3) foo", listContinuationForEnter("3) foo", 6)!)).toBe("3) foo\n4) ");
  });

  it("continues bullets and keeps indentation", () => {
    expect(applyEdit("- foo", listContinuationForEnter("- foo", 5)!)).toBe("- foo\n- ");
    expect(applyEdit("  * foo", listContinuationForEnter("  * foo", 7)!)).toBe("  * foo\n  * ");
  });

  it("continues tasks unchecked", () => {
    expect(applyEdit("- [x] done", listContinuationForEnter("- [x] done", 10)!)).toBe(
      "- [x] done\n- [ ] ",
    );
  });

  it("splits mid-line items", () => {
    expect(applyEdit("1. foobar", listContinuationForEnter("1. foobar", 5)!)).toBe(
      "1. fo\n2. obar",
    );
  });

  it("exits the list on an empty item", () => {
    expect(applyEdit("1. foo\n2. ", listContinuationForEnter("1. foo\n2. ", 10)!)).toBe("1. foo\n");
    expect(applyEdit("- ", listContinuationForEnter("- ", 2)!)).toBe("");
  });

  it("ignores non-list lines and carets inside the marker", () => {
    expect(listContinuationForEnter("plain text", 5)).toBeNull();
    expect(listContinuationForEnter("1.foo no space", 3)).toBeNull();
    expect(listContinuationForEnter("-foo", 2)).toBeNull();
    expect(listContinuationForEnter("1. foo", 1)).toBeNull();
  });

  it("refuses to split a supplementary currency skill chip", () => {
    const value = "1. 𑿝review go";
    const cursor = value.indexOf(" go") - 1;
    expect(listContinuationForEnter(value, cursor)).toBeNull();
  });

  it("refuses to split an inline chip", () => {
    const value = "1. @README.md go";
    const cursor = value.indexOf("README") + 2;
    expect(listContinuationForEnter(value, cursor)).toBeNull();
  });

  it.each([
    ["1. a\n   1. ", "1. a\n2. "],
    ["1) a\n   1) x\n   2) ", "1) a\n   1) x\n2) "],
    ["- a\n  1. ", "- a\n- "],
    ["1. a\n   - [ ] ", "1. a\n2. "],
    ["1. a\n   1. x\n      1. ", "1. a\n   1. x\n   2. "],
  ])("leaves one level of nesting on an empty nested item in %j", (value, expected) => {
    expect(applyEdit(value, listContinuationForEnter(value, value.length)!)).toBe(expected);
  });

  it("exits the list on an empty item indented with no parent", () => {
    expect(applyEdit("  - ", listContinuationForEnter("  - ", 4)!)).toBe("");
  });
});

describe("listIndentForTab", () => {
  function tab(value: string, cursor = value.length) {
    const edit = listIndentForTab(value, cursor, cursor);
    return edit && { value: applyEdit(value, edit), cursor: edit.cursor };
  }

  it.each([
    // Children nest at the item's content column, so Markdown reads them as nested.
    ["1. a\n2. ", "1. a\n   1. "],
    ["1. a\n2. b", "1. a\n   1. b"],
    ["10) a\n11) ", "10) a\n    1) "],
    ["1. a\n   1. x\n2. ", "1. a\n   1. x\n   2. "],
    ["1. a\n   1. x\n      1. y\n2. ", "1. a\n   1. x\n      1. y\n   2. "],
    ["1. a\n   - x\n2. ", "1. a\n   - x\n   1. "],
    ["1. a\n  1. x\n2. ", "1. a\n  1. x\n  2. "],
    ["- a\n- ", "- a\n  - "],
    ["- [ ] a\n- [ ] ", "- [ ] a\n  - [ ] "],
    ["- a\n1. ", "- a\n  1. "],
  ])("nests the last item of %j", (value, expected) => {
    const result = tab(value);
    expect(result?.value).toBe(expected);
    expect(result?.cursor).toBe(expected.length);
  });

  it("keeps the caret on the item text", () => {
    const value = "1. a\n2. bc";
    expect(tab(value, value.length - 1)).toEqual({ value: "1. a\n   1. bc", cursor: 12 });
  });

  it("indents by two spaces with no item to nest under", () => {
    expect(tab("- foo", 2)).toEqual({ value: "  - foo", cursor: 4 });
    expect(tab("text\n1. ")).toEqual({ value: "text\n  1. ", cursor: 10 });
    expect(tab("1. a\n   1. ")).toEqual({ value: "1. a\n     1. ", cursor: 13 });
  });

  it("ignores non-list lines and ranged selections", () => {
    expect(listIndentForTab("plain", 2, 2)).toBeNull();
    expect(listIndentForTab("- foo", 1, 3)).toBeNull();
  });
});

describe("nextOrderedMarkerText", () => {
  it.each([
    ["1.", "2."],
    ["1)", "2)"],
    ["09.", "10."],
    ["001)", "002)"],
    ["99.", "100."],
    ["99999999999999999999.", "99999999999999999999."],
  ])("counts %s up to %s", (marker, expected) => {
    expect(nextOrderedMarkerText(marker)).toBe(expected);
  });
});
