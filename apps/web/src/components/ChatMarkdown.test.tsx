import { describe, expect, it } from "vite-plus/test";

import { firstStrongDirection, orderedListGutterStyle } from "./ChatMarkdown";

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});

describe("firstStrongDirection", () => {
  it("reads the first letter, skipping neutral digits and punctuation", () => {
    expect(firstStrongDirection("רכיב | סטטוס")).toBe("rtl");
    expect(firstStrongDirection("1. (שלב) ראשון")).toBe("rtl");
    expect(firstStrongDirection("\u{1E900}\u{1E92F} adlam")).toBe("rtl"); // astral RTL block
    expect(firstStrongDirection("Component | Status")).toBe("ltr");
    expect(firstStrongDirection("42 — Next.js then עברית")).toBe("ltr");
  });

  it("falls back to ltr when there is no strong character", () => {
    expect(firstStrongDirection("")).toBe("ltr");
    expect(firstStrongDirection("123 | 456")).toBe("ltr");
  });
});
