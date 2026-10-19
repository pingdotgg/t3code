import { describe, expect, it } from "vite-plus/test";

import { resolveThreadLineageWindow } from "./ThreadRelationshipsControl";

const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

describe("thread lineage window", () => {
  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = resolveThreadLineageWindow(rows, 6);

    expect(visibleRows).toEqual(rows.slice(0, 6));
    expect(hiddenCount).toBe(14);
  });

  it("hides nothing when everything fits", () => {
    expect(resolveThreadLineageWindow(rows, rows.length).hiddenCount).toBe(0);
    expect(resolveThreadLineageWindow(rows.slice(0, 6), 6).hiddenCount).toBe(0);
  });
});
