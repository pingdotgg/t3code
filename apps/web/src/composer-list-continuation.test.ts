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

  it("indents list items on Tab", () => {
    expect(applyEdit("- foo", listIndentForTab("- foo", 2, 2)!)).toBe("  - foo");
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

describe("composer list renumbering", () => {
  it("renumbers following items with their padding and leaves the caret after the inserted marker", () => {
    const value = "1. @README.md go\n2. two\n03. three\n10. four";
    const edit = listContinuationForEnter(value, value.indexOf("go"))!;
    expect(applyEdit(value, edit)).toBe("1. @README.md \n2. go\n3. two\n04. three\n5. four");
    expect(edit.cursorAfter).toBe("1. @README.md \n2. ".length);
  });

  it("renumbers indented paren siblings across tab-indented children and stops at a parent", () => {
    const value = "  1) a\n\t1) child\n  2) b\n1) parent\n  3) untouched";
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe(
      "  1) a\n  2) \n\t1) child\n  3) b\n1) parent\n  3) untouched",
    );
    expect(edit.cursorAfter).toBe("  1) a\n  2) ".length);
  });

  it.each([
    ["a blank line", ""],
    ["plain text", "text"],
    ["a different delimiter", "1) other list"],
  ])("stops renumbering at %s", (_label, boundary) => {
    const value = `1. a\n2. b\n${boundary}\n3. untouched`;
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe(`1. a\n2. \n3. b\n${boundary}\n3. untouched`);
  });

  it("preserves multiline chip contents while renumbering surrounding items", () => {
    const value = '1. a\n2. @"file\n2. name" \n3. b';
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe('1. a\n2. \n3. @"file\n2. name" \n4. b');
  });
});
