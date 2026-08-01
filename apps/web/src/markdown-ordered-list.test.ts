import { describe, expect, it } from "vite-plus/test";

import { orderedListMarkerExtraDigits } from "./markdown-ordered-list";

describe("orderedListMarkerExtraDigits", () => {
  it("keeps the base padding for lists whose markers fit two digits", () => {
    expect(orderedListMarkerExtraDigits(undefined, 1)).toBe(0);
    expect(orderedListMarkerExtraDigits(undefined, 9)).toBe(0);
    expect(orderedListMarkerExtraDigits(undefined, 99)).toBe(0);
    expect(orderedListMarkerExtraDigits(98, 2)).toBe(0);
  });

  it("adds one ch per digit past two in the widest marker", () => {
    expect(orderedListMarkerExtraDigits(undefined, 100)).toBe(1);
    expect(orderedListMarkerExtraDigits(undefined, 200)).toBe(1);
    expect(orderedListMarkerExtraDigits(undefined, 1000)).toBe(2);
  });

  it("sizes from the start attribute, not just the item count", () => {
    // A short list continuing earlier numbering: `98.`–`102.`
    expect(orderedListMarkerExtraDigits(98, 5)).toBe(1);
    // High-start lists clip immediately without this: `999995.`–`999999.`
    expect(orderedListMarkerExtraDigits(999995, 5)).toBe(4);
    // A single-item nested list parsed out of `- 101. text`
    expect(orderedListMarkerExtraDigits(101, 1)).toBe(1);
  });

  it("tolerates empty and streaming-partial lists", () => {
    expect(orderedListMarkerExtraDigits(undefined, 0)).toBe(0);
    expect(orderedListMarkerExtraDigits(100, 0)).toBe(1);
  });
});
