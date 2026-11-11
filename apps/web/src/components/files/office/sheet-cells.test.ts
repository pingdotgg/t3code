import { describe, expect, it } from "vite-plus/test";

import { coverMerges } from "./sheet-cells";

describe("coverMerges", () => {
  it.each([false, true])("expands a long merge chain (reversed: %s)", (reversed) => {
    const count = 15_000;
    const merges = Array.from({ length: count }, (_, i) => ({
      top: i,
      bottom: i + 1,
      left: i % 2,
      right: i % 2,
    }));
    if (reversed) merges.reverse();
    const range = { top: count, bottom: count, left: 0, right: 1 };

    expect(coverMerges(range, merges)).toEqual({ ...range, top: 0 });
    expect(range.top).toBe(count);
  });

  it("revisits merges reached through expansion on every edge without including distant merges", () => {
    const merges = [
      { top: 1, bottom: 1, left: 0, right: 2 },
      { top: 1, bottom: 2, left: 3, right: 3 },
      { top: 3, bottom: 3, left: 3, right: 5 },
      { top: 2, bottom: 5, left: 2, right: 2 },
      { top: 6, bottom: 7, left: 6, right: 7 },
    ];
    const range = { top: 3, bottom: 3, left: 2, right: 3 };

    expect(coverMerges(range, merges)).toEqual({ top: 1, bottom: 5, left: 0, right: 5 });
    expect(coverMerges(range, [])).toEqual(range);
    expect(coverMerges({ top: 6, bottom: 6, left: 0, right: 0 }, merges)).toEqual({
      top: 6,
      bottom: 6,
      left: 0,
      right: 0,
    });
  });
});
