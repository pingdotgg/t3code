import { describe, expect, it } from "vite-plus/test";
import type { SidebarThreadRowPlacement } from "@t3tools/contracts/settings";
import { dropThreadDetail, threadRowBlankSpace } from "./ThreadRowLayoutEditor.logic";

const layout: ReadonlyArray<SidebarThreadRowPlacement> = [
  { component: "projectIcon", row: 1, alignment: "left" },
  { component: "title", row: 1, alignment: "left" },
  { component: "activity", row: 1, alignment: "right" },
];

describe("dropping thread details", () => {
  it("adds a hidden detail to an empty row side", () => {
    expect(
      dropThreadDetail(layout, "model", { kind: "place", row: 2, alignment: "right" }),
    ).toEqual([...layout, { component: "model", row: 2, alignment: "right" }]);
  });

  it("moves an existing detail between rows without duplicating it", () => {
    const next = dropThreadDetail(layout, "title", { kind: "place", row: 3, alignment: "right" });
    expect(next).toEqual([
      layout[0],
      layout[2],
      { component: "title", row: 3, alignment: "right" },
    ]);
    expect(layout[1]?.row).toBe(1);
  });

  it("reorders before and after a peer in the same row", () => {
    const next = dropThreadDetail(layout, "title", {
      kind: "place",
      row: 1,
      alignment: "left",
      relativeTo: "projectIcon",
      edge: "before",
    });
    expect(next.map((item) => item.component)).toEqual(["title", "projectIcon", "activity"]);
    expect(
      dropThreadDetail(next, "title", {
        kind: "place",
        row: 1,
        alignment: "left",
        relativeTo: "projectIcon",
        edge: "after",
      }),
    ).toEqual(layout);
  });

  it("moves across sides next to another detail", () => {
    expect(
      dropThreadDetail(layout, "title", {
        kind: "place",
        row: 1,
        alignment: "right",
        relativeTo: "activity",
        edge: "after",
      }),
    ).toEqual([layout[0], layout[2], { component: "title", row: 1, alignment: "right" }]);
  });

  it("appends when dropped into the empty space of an occupied side", () => {
    expect(
      dropThreadDetail(layout, "projectIcon", { kind: "place", row: 1, alignment: "left" })
        .filter((item) => item.alignment === "left")
        .map((item) => item.component),
    ).toEqual(["title", "projectIcon"]);
  });

  it("hides a detail but never removes the final visible detail", () => {
    expect(dropThreadDetail(layout, "title", { kind: "hide" })).toEqual([layout[0], layout[2]]);
    const onlyTitle = [{ component: "title", row: 1, alignment: "left" }] as const;
    expect(dropThreadDetail(onlyTitle, "title", { kind: "hide" })).toBe(onlyTitle);
    expect(dropThreadDetail(layout, "model", { kind: "hide" })).toBe(layout);
  });

  it("preserves saved settings on cancellation, outside drops and self-drops", () => {
    expect(dropThreadDetail(layout, "title", null)).toBe(layout);
    expect(
      dropThreadDetail(layout, "title", {
        kind: "place",
        row: 1,
        alignment: "left",
        relativeTo: "title",
        edge: "before",
      }),
    ).toBe(layout);
    expect(
      dropThreadDetail(layout, "title", {
        kind: "place",
        row: 1,
        alignment: "left",
        relativeTo: "projectIcon",
        edge: "after",
      }),
    ).toBe(layout);
  });
});

describe("blank-space drop targets", () => {
  const row = { left: 100, right: 460 };

  it("uses the full width for an empty row or an unoccupied side", () => {
    expect(threadRowBlankSpace(row, [], [])).toEqual({ left: 0, width: 360 });
    expect(threadRowBlankSpace(row, [{ right: 180 }], [])).toEqual({ left: 80, width: 280 });
    expect(threadRowBlankSpace(row, [], [{ left: 420 }])).toEqual({ left: 0, width: 320 });
  });

  it("splits the actual gap between visible details rather than the flex container", () => {
    const gap = threadRowBlankSpace(
      row,
      [{ right: 130 }, { right: 210 }],
      [{ left: 430 }, { left: 410 }],
    );
    expect(gap).toEqual({ left: 110, width: 200 });
    // The right target starts halfway through the visible gap, well before the right group.
    expect(row.left + gap.left + gap.width / 2).toBe(310);
  });

  it("does not expose a gap when details fill or overflow the row", () => {
    expect(threadRowBlankSpace(row, [{ right: 420 }], [{ left: 410 }]).width).toBe(0);
    expect(threadRowBlankSpace(row, [{ right: 480 }], []).width).toBe(0);
  });
});
