import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";

import {
  applySplitChange,
  reconcileSplit,
  restorePersistedSplit,
  type SplitChange,
  splitWidenTarget,
  type SplitWriteKind,
  widthToGiveBack,
} from "./splitLayout.logic";

function surface(id: string): RightPanelSurface {
  if (id === "files") return { id, kind: "files" };
  if (id === "diff") return { id, kind: "diff" };
  return { id: `file:${id}`, kind: "file", relativePath: id, revealLine: null, revealRequestId: 1 };
}

const sid = (id: string) => surface(id).id;

function unsplit(ids: readonly string[], active: string | null): ThreadRightPanelState {
  return {
    isOpen: true,
    activeSurfaceId: active === null ? null : sid(active),
    surfaces: ids.map(surface),
  };
}

function split(
  left: readonly string[],
  right: readonly string[],
  active: string,
  other: string,
  ratio = 0.5,
): ThreadRightPanelState {
  return {
    ...unsplit([...left, ...right], active),
    split: { rightIds: right.map(sid), otherShownId: sid(other), ratio },
  };
}

/** A store write in the shape the upstream actions produce: new surfaces and a new active id. */
function written(
  prev: ThreadRightPanelState,
  ids: readonly string[],
  active: string | null,
): ThreadRightPanelState {
  return {
    ...prev,
    surfaces: ids.map(surface),
    activeSurfaceId: active === null ? null : sid(active),
  };
}

function view(state: ThreadRightPanelState) {
  const ids = (list: readonly RightPanelSurface[]) => list.map((entry) => entry.id);
  if (state.split === undefined) {
    return { surfaces: ids(state.surfaces), active: state.activeSurfaceId };
  }
  const right = new Set<string>(state.split.rightIds);
  const left = ids(state.surfaces.filter((entry) => !right.has(entry.id)));
  const rightIds = ids(state.surfaces.filter((entry) => right.has(entry.id)));
  return {
    left,
    right: rightIds,
    active: state.activeSurfaceId,
    other: state.split.otherShownId,
    ratio: state.split.ratio,
    partitioned: ids(state.surfaces).join() === [...left, ...rightIds].join(),
  };
}

function panes(left: string[], right: string[], active: string, other: string, ratio = 0.5) {
  return {
    left: left.map(sid),
    right: right.map(sid),
    active: sid(active),
    other: sid(other),
    ratio,
    partitioned: true,
  };
}

function single(ids: string[], active: string | null) {
  return { surfaces: ids.map(sid), active: active === null ? null : sid(active) };
}

describe("reconcileSplit", () => {
  const rows: ReadonlyArray<{
    name: string;
    prev: ThreadRightPanelState;
    next: (prev: ThreadRightPanelState) => ThreadRightPanelState;
    kind: SplitWriteKind;
    expected: ReturnType<typeof panes> | ReturnType<typeof single>;
  }> = [
    {
      name: "R1: an open while the right pane is focused lands in the right pane",
      prev: split(["a", "b"], ["c"], "c", "a"),
      next: (prev) => written(prev, ["a", "b", "c", "d"], "d"),
      kind: "user",
      expected: panes(["a", "b"], ["c", "d"], "d", "a"),
    },
    {
      name: "R1: an open while the left pane is focused lands in the left pane",
      prev: split(["a", "b"], ["c"], "a", "c"),
      next: (prev) => written(prev, ["a", "b", "c", "d"], "d"),
      kind: "automatic",
      expected: panes(["a", "b", "d"], ["c"], "d", "c"),
    },
    {
      name: "R1b: a chat link replacing an explorer alone in the unfocused pane keeps the split",
      prev: split(["a", "b"], ["files"], "a", "files"),
      next: (prev) => written(prev, ["a", "b", "x"], "x"),
      kind: "user",
      expected: panes(["a", "b"], ["x"], "x", "a"),
    },
    {
      name: "R1b: a replacement of the focused pane's only tab stays in that pane",
      prev: split(["files"], ["c"], "files", "c"),
      next: (prev) => written(prev, ["c", "x"], "x"),
      kind: "user",
      expected: panes(["x"], ["c"], "x", "c"),
    },
    {
      name: "R2: closing the focused pane's last tab keeps the surviving pane's shown tab",
      prev: split(["a"], ["c", "d"], "a", "d"),
      next: (prev) => written(prev, ["c", "d"], "c"),
      kind: "close",
      expected: single(["c", "d"], "d"),
    },
    {
      name: "R2: closing the unfocused pane's last tab keeps the focused tab",
      prev: split(["a", "b"], ["c"], "b", "c"),
      next: (prev) => written(prev, ["a", "b"], "b"),
      kind: "close",
      expected: single(["a", "b"], "b"),
    },
    {
      name: "R2: a user write that empties a pane keeps the target it named",
      prev: split(["files"], ["x", "y"], "files", "y"),
      next: (prev) => written(prev, ["x", "y"], "x"),
      kind: "user",
      expected: single(["x", "y"], "x"),
    },
    {
      name: "R3: closing the active tab falls back inside its pane, not across",
      prev: split(["a", "b"], ["c"], "b", "c"),
      next: (prev) => written(prev, ["a", "c"], "c"),
      kind: "close",
      expected: panes(["a"], ["c"], "a", "c"),
    },
    {
      name: "R3: an automatic removal of the active tab also falls back inside its pane",
      prev: split(["a", "b", "e"], ["c", "d"], "b", "d"),
      next: (prev) => written(prev, ["a", "e", "c", "d"], "a"),
      kind: "automatic",
      expected: panes(["a", "e"], ["c", "d"], "e", "d"),
    },
    {
      name: "R3: a user navigation to a tab in the other pane is not overridden",
      prev: split(["a", "files", "b"], ["x"], "files", "x"),
      next: (prev) => written(prev, ["a", "b", "x"], "x"),
      kind: "user",
      expected: panes(["a", "b"], ["x"], "x", "a"),
    },
    {
      name: "R4: activating a tab in the other pane remembers what this pane showed",
      prev: split(["a", "b"], ["c", "d"], "b", "d"),
      next: (prev) => written(prev, ["a", "b", "c", "d"], "c"),
      kind: "user",
      expected: panes(["a", "b"], ["c", "d"], "c", "b"),
    },
    {
      name: "the unfocused pane's shown tab closing falls back to its neighbour",
      prev: split(["a"], ["c", "d", "e"], "a", "d"),
      next: (prev) => written(prev, ["a", "c", "e"], "a"),
      kind: "close",
      expected: panes(["a"], ["c", "e"], "a", "e"),
    },
    {
      name: "R5: an upstream move across the boundary is re-partitioned",
      prev: split(["a", "b"], ["c"], "a", "c"),
      next: (prev) => written(prev, ["a", "c", "b"], "a"),
      kind: "automatic",
      expected: panes(["a", "b"], ["c"], "a", "c"),
    },
  ];

  it.each(rows)("$name", (row) => {
    expect(view(reconcileSplit(row.prev, row.next(row.prev), row.kind))).toEqual(row.expected);
  });

  it("passes a valid state and a thread without a split through by reference", () => {
    const valid = split(["a"], ["b", "c"], "b", "a");
    expect(reconcileSplit(valid, valid, "user")).toBe(valid);
    const flat = unsplit(["a", "b"], "a");
    const next = written(flat, ["a", "b", "c"], "c");
    expect(reconcileSplit(flat, next, "user")).toBe(next);
  });
});

describe("applySplitChange", () => {
  const rows: ReadonlyArray<{
    name: string;
    thread: ThreadRightPanelState;
    change: SplitChange;
    expected: ReturnType<typeof panes> | ReturnType<typeof single> | "same";
  }> = [
    {
      name: "split right: the source pane gets back the tab it showed before the press",
      thread: unsplit(["a", "b", "c"], "b"),
      change: { type: "split", surfaceId: sid("b"), side: "right", restoreShown: sid("a") },
      expected: panes(["a", "c"], ["b"], "b", "a"),
    },
    {
      name: "split left from the menu keeps the active tab in the other pane",
      thread: unsplit(["a", "b", "c"], "a"),
      change: { type: "split", surfaceId: sid("c"), side: "left" },
      expected: panes(["c"], ["a", "b"], "c", "a"),
    },
    {
      name: "split needs two tabs",
      thread: unsplit(["a"], "a"),
      change: { type: "split", surfaceId: sid("a"), side: "right" },
      expected: "same",
    },
    {
      name: "move to the other pane focuses it there; the source pane keeps its tab",
      thread: split(["a", "b"], ["c"], "a", "c"),
      change: { type: "move", surfaceId: sid("b"), pane: "right", beforeId: sid("c") },
      expected: panes(["a"], ["b", "c"], "b", "a"),
    },
    {
      name: "move with restoreShown gives the source pane back its press-time tab",
      thread: split(["a", "b"], ["c"], "b", "c"),
      change: {
        type: "move",
        surfaceId: sid("b"),
        pane: "right",
        beforeId: null,
        restoreShown: sid("a"),
      },
      expected: panes(["a"], ["c", "b"], "b", "a"),
    },
    {
      name: "moving a pane's only tab to the other pane unsplits",
      thread: split(["a"], ["b", "c"], "b", "a"),
      change: { type: "move", surfaceId: sid("a"), pane: "right", beforeId: sid("c") },
      expected: single(["b", "a", "c"], "a"),
    },
    {
      name: "reorder within the right pane keeps the active tab",
      thread: split(["a"], ["b", "c", "d"], "a", "c"),
      change: { type: "reorder", surfaceId: sid("d"), beforeId: sid("b") },
      expected: panes(["a"], ["d", "b", "c"], "a", "c"),
    },
    {
      name: "reorder to the end of the left pane stays in the left pane",
      thread: split(["a", "b"], ["c"], "a", "c"),
      change: { type: "reorder", surfaceId: sid("a"), beforeId: null },
      expected: panes(["b", "a"], ["c"], "a", "c"),
    },
    {
      name: "reorder without a split moves in the flat list",
      thread: unsplit(["a", "b", "c"], "b"),
      change: { type: "reorder", surfaceId: sid("a"), beforeId: null },
      expected: single(["b", "c", "a"], "b"),
    },
    {
      name: "unsplit keeps order and the active tab",
      thread: split(["a"], ["b", "c"], "c", "a"),
      change: { type: "unsplit" },
      expected: single(["a", "b", "c"], "c"),
    },
    {
      name: "focus the other pane shows its tab and remembers this one",
      thread: split(["a", "b"], ["c"], "b", "c"),
      change: { type: "focus", pane: "right" },
      expected: panes(["a", "b"], ["c"], "c", "b"),
    },
    {
      name: "focus the focused pane changes nothing",
      thread: split(["a"], ["b"], "a", "b"),
      change: { type: "focus", pane: "left" },
      expected: "same",
    },
    {
      name: "ratio is clamped",
      thread: split(["a"], ["b"], "a", "b"),
      change: { type: "ratio", ratio: 0.95 },
      expected: panes(["a"], ["b"], "a", "b", 0.8),
    },
    {
      name: "an unchanged ratio changes nothing",
      thread: split(["a"], ["b"], "a", "b", 0.3),
      change: { type: "ratio", ratio: 0.3 },
      expected: "same",
    },
    {
      name: "a stale command is a no-op",
      thread: split(["a"], ["b"], "a", "b"),
      change: { type: "move", surfaceId: sid("gone"), pane: "right", beforeId: null },
      expected: "same",
    },
  ];

  it.each(rows)("$name", (row) => {
    const next = applySplitChange(row.thread, row.change);
    if (row.expected === "same") expect(next).toBe(row.thread);
    else expect(view(next)).toEqual(row.expected);
    expect(reconcileSplit(row.thread, next, "user")).toBe(next);
  });
});

describe("restorePersistedSplit", () => {
  const record = unsplit(["a", "b", "c"], "a");

  it.each([
    ["a v14 record has no split", undefined, single(["a", "b", "c"], "a")],
    [
      "dangling ids are dropped",
      { rightIds: [sid("c"), "file:gone"], otherShownId: sid("c"), ratio: 0.4 },
      panes(["a", "b"], ["c"], "a", "c", 0.4),
    ],
    [
      "only dangling ids drop the split",
      { rightIds: ["file:gone"], otherShownId: "x" },
      single(["a", "b", "c"], "a"),
    ],
    [
      "a split holding every tab is dropped",
      { rightIds: ["a", "b", "c"].map(sid), otherShownId: sid("b") },
      single(["a", "b", "c"], "a"),
    ],
    [
      "a malformed value is dropped",
      { rightIds: "c", otherShownId: 3 },
      single(["a", "b", "c"], "a"),
    ],
    [
      "a same-version record is repaired: order, shown tab and ratio",
      { rightIds: [sid("a")], otherShownId: sid("a"), ratio: 3 },
      panes(["b", "c"], ["a"], "a", "b", 0.8),
    ],
  ] as const)("%s", (_name, raw, expected) => {
    expect(view(restorePersistedSplit(record, raw))).toEqual(expected);
  });
});

describe("split width", () => {
  it.each([
    ["widens a narrow panel to the comfortable width", 540, 1000, 800],
    ["widens only as far as the chat column allows", 540, 700, 700],
    ["leaves a panel at its cap", 540, 540, null],
    ["leaves a panel already wide enough", 900, 1000, null],
  ] as const)("%s", (_name, width, maxWidth, expected) => {
    expect(splitWidenTarget(width, maxWidth)).toBe(expected);
  });

  it("gives the width back only while the panel keeps the width the split set", () => {
    expect(widthToGiveBack(800, { before: 540, set: 800 })).toBe(540);
    expect(widthToGiveBack(650, { before: 540, set: 800 })).toBeNull();
  });
});
