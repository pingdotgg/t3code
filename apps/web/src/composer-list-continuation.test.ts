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
    expect(applyEdit("1)\t", listContinuationForEnter("1)\t", 3)!)).toBe("");
    expect(applyEdit("- [ ] ", listContinuationForEnter("- [ ] ", 6)!)).toBe("");
  });

  it("lifts an empty nested item one level per press before leaving the list", () => {
    let value = "1. parent\n   1. child\n      1. ";
    for (const expected of [
      "1. parent\n   1. child\n   2. ",
      "1. parent\n   1. child\n2. ",
      "1. parent\n   1. child\n",
    ]) {
      value = applyEdit(value, listContinuationForEnter(value, value.length)!);
      expect(value).toBe(expected);
    }
  });

  it("renumbers the parent list after lifting an empty nested item", () => {
    const value = "1. a\n   1. \n2. b";
    const edit = listContinuationForEnter(value, value.indexOf("\n2."))!;
    expect(applyEdit(value, edit)).toBe("1. a\n2. \n3. b");
    expect(edit.cursorAfter).toBe("1. a\n2. ".length);
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
});

describe("composer list indentation", () => {
  // regression: #17124 Tab must nest a numbered item at its parent's content column
  it.each([
    ["1. parent\n2. child", "1. parent\n   1. child"],
    ["10. parent\n11. child", "10. parent\n    1. child"],
    ["1.\tparent\n2. child", "1.\tparent\n    1. child"],
    ['1. @"file\n   9. name"\n2. child', '1. @"file\n   9. name"\n   1. child'],
  ])("nests %j as a first child and keeps the caret on its text", (value, expected) => {
    const cursor = value.lastIndexOf("child") + 2;
    const edit = listIndentForTab(value, cursor, cursor)!;
    expect(applyEdit(value, edit)).toBe(expected);
    expect(edit.cursorAfter).toBe(expected.lastIndexOf("child") + 2);
  });

  it("continues the numbering of an existing nested sibling", () => {
    const value = "1. parent\n   1. first\n2. second";
    const edit = listIndentForTab(value, value.length, value.length)!;
    expect(applyEdit(value, edit)).toBe("1. parent\n   1. first\n   2. second");
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

  // regression: #14332 continuing a numbered list must renumber following items only up to the list boundary
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
