import { describe, expect, it } from "vite-plus/test";

import { layoutThreadGroups } from "./threadGroups.ts";

const ORDER = ["pinned", "active", "settled"] as const;
type Section = (typeof ORDER)[number];

interface TestThread {
  readonly id: string;
  readonly groupedUnder?: string;
}

function layout(sections: Partial<Record<Section, readonly TestThread[]>>) {
  const result = layoutThreadGroups({
    sections: { pinned: [], active: [], settled: [], ...sections },
    order: ORDER,
    live: new Set<Section>(["pinned", "active"]),
    keyOf: (thread) => thread.id,
    groupKeyOf: (thread) => thread.groupedUnder ?? null,
  });
  // Compact form: one string per block, "root>child(section)", with the
  // block's lead row marked by "*".
  const describeSection = (section: Section) =>
    result[section].map((block) =>
      block.rows
        .map((row) => {
          const label = row.rootKey === null ? row.key : `${row.key}(${row.section})`;
          return block.rows.length > 1 && row.key === block.leadKey ? `${label}*` : label;
        })
        .join(">"),
    );
  return {
    pinned: describeSection("pinned"),
    active: describeSection("active"),
    settled: describeSection("settled"),
  };
}

describe("layoutThreadGroups", () => {
  it("nests grouped threads, and threads grouped under them, under the top thread", () => {
    expect(
      layout({
        pinned: [{ id: "lead" }],
        active: [{ id: "a", groupedUnder: "lead" }, { id: "solo" }, { id: "b", groupedUnder: "a" }],
        settled: [{ id: "c", groupedUnder: "lead" }],
      }),
    ).toEqual({
      pinned: ["lead*>a(active)>b(active)>c(settled)"],
      active: ["solo"],
      settled: [],
    });
  });

  it("moves a settled top thread's group to its first live thread", () => {
    expect(
      layout({
        active: [{ id: "solo" }, { id: "a", groupedUnder: "lead" }],
        settled: [{ id: "lead" }, { id: "b", groupedUnder: "lead" }],
      }),
    ).toEqual({
      pinned: [],
      active: ["solo", "lead>a(active)*>b(settled)"],
      settled: [],
    });
  });

  it("anchors a settled top thread's group to the same live thread in any order", () => {
    // Moving the anchor "a" below "solo" moves the group; "b" does not take
    // its place.
    expect(
      layout({
        active: [
          { id: "a", groupedUnder: "lead" },
          { id: "b", groupedUnder: "lead" },
          { id: "solo" },
        ],
        settled: [{ id: "lead" }],
      }).active,
    ).toEqual(["lead>a(active)*>b(active)", "solo"]);
    expect(
      layout({
        active: [
          { id: "b", groupedUnder: "lead" },
          { id: "solo" },
          { id: "a", groupedUnder: "lead" },
        ],
        settled: [{ id: "lead" }],
      }).active,
    ).toEqual(["solo", "lead>b(active)>a(active)*"]);
  });

  it("keeps threads top-level when their group's thread is not listed or the chain loops", () => {
    expect(
      layout({
        active: [
          { id: "orphan", groupedUnder: "archived" },
          { id: "x", groupedUnder: "y" },
          { id: "y", groupedUnder: "x" },
        ],
      }),
    ).toEqual({ pinned: [], active: ["orphan", "x", "y"], settled: [] });
  });
});
