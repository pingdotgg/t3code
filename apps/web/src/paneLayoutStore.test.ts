import { describe, expect, it } from "vite-plus/test";

import { equalPaneSizes } from "./paneLayout";
import { sanitizePersistedLayout, sanitizePersistedSizes } from "./paneLayoutStore";

const entry = (id: string, threadId: string) => ({
  id,
  ref: { environmentId: "env", threadId },
});

describe("sanitizePersistedLayout", () => {
  it("keeps well-formed panes and clamps the focused index", () => {
    const layout = sanitizePersistedLayout({
      panes: [entry("p1", "a"), entry("p2", "b")],
      focusedIndex: 9,
    });
    expect(layout.panes.map((pane) => pane.ref.threadId)).toEqual(["a", "b"]);
    expect(layout.focusedIndex).toBe(1);
  });

  it("drops malformed, duplicate, and surplus panes from edited storage", () => {
    const layout = sanitizePersistedLayout({
      panes: [
        entry("p1", "a"),
        entry("p2", "a"),
        { id: "p3", ref: { environmentId: "env" } },
        entry("p4", " "),
        null,
        ...["b", "c", "d", "e", "f", "g"].map((name) => entry(`x-${name}`, name)),
      ],
      focusedIndex: -3,
    });
    expect(layout.panes.map((pane) => pane.ref.threadId)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(layout.focusedIndex).toBe(0);
  });

  it("falls back to an empty layout for anything else", () => {
    expect(sanitizePersistedLayout("nope").panes).toEqual([]);
    expect(sanitizePersistedLayout({ panes: "nope" }).panes).toEqual([]);
  });
});

describe("sanitizePersistedSizes", () => {
  it("keeps sizes that still describe the grid", () => {
    const sizes = {
      ...equalPaneSizes(5),
      rows: [0.6, 0.4],
      cols: [
        [0.2, 0.3, 0.5],
        [0.5, 0.5],
      ],
    };
    expect(sanitizePersistedSizes(sizes, 5)).toEqual(sizes);
    const singleRow = { ...equalPaneSizes(2), cols: [[0.7, 0.3]] };
    expect(sanitizePersistedSizes(singleRow, 2)).toEqual(singleRow);
  });

  it.each([
    { name: "another pane count", value: equalPaneSizes(4), count: 5 },
    {
      name: "fractions that do not sum to one",
      value: { ...equalPaneSizes(2), cols: [[0.2, 0.2]] },
      count: 2,
    },
    {
      name: "a row of the wrong length",
      value: { ...equalPaneSizes(4), cols: [[1], [0.5, 0.5]] },
      count: 4,
    },
    { name: "non-numbers", value: { count: 2, rows: ["x"], cols: [] }, count: 2 },
    { name: "nothing", value: undefined, count: 2 },
  ])("rejects $name", ({ value, count }) => {
    expect(sanitizePersistedSizes(value, count)).toBeNull();
  });
});
