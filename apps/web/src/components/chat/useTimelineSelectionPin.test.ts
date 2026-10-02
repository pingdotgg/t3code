import { describe, expect, it } from "vite-plus/test";
import { pinSelectedTimelineRows } from "./useTimelineSelectionPin";

const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

describe("pinSelectedTimelineRows", () => {
  it("pins every row from the anchor down to the focus", () => {
    expect(pinSelectedTimelineRows(rows, { anchorRowId: "b", focusRowId: "d" }, undefined)).toEqual(
      { indices: [1, 2, 3] },
    );
  });

  it("pins the same span when the selection runs upward", () => {
    expect(pinSelectedTimelineRows(rows, { anchorRowId: "d", focusRowId: "b" }, undefined)).toEqual(
      { indices: [1, 2, 3] },
    );
  });

  it("keeps the pins the list already has, in order and without duplicates", () => {
    expect(
      pinSelectedTimelineRows(
        rows,
        { anchorRowId: "d", focusRowId: "b" },
        { indices: [4, 2], keys: ["cited"] },
      ),
    ).toEqual({ indices: [1, 2, 3, 4], keys: ["cited"] });
  });

  it("leaves the list's pins alone without a selection or when its rows are gone", () => {
    const alwaysRender = { keys: ["cited"] };
    expect(pinSelectedTimelineRows(rows, null, alwaysRender)).toBe(alwaysRender);
    expect(
      pinSelectedTimelineRows(rows, { anchorRowId: "gone", focusRowId: "c" }, alwaysRender),
    ).toBe(alwaysRender);
  });
});
