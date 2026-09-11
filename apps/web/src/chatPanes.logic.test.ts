import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLeaves,
  filterPaneTree,
  findLeaf,
  findNode,
  removePane,
  resolveDropZone,
  resolveEdgeDropZone,
  selectChatPaneRoot,
  setPaneRatio,
  splitPane,
  type ChatPaneLeaf,
  type ChatPaneNode,
} from "./chatPanes.logic";

const leaf = (id: string): ChatPaneLeaf => ({
  kind: "leaf",
  id,
  threadRef: scopeThreadRef("env-1" as EnvironmentId, ThreadId.make(`thread-${id}`)),
});
const rect = { left: 0, top: 0, width: 300, height: 100 };

it("keeps a pane group intact while navigating outside it and back", () => {
  const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
  const other = splitPane(leaf("c"), "c", "right", leaf("d"), "s2");
  expect(selectChatPaneRoot([root, other], leaf("a").threadRef)).toBe(root);
  expect(selectChatPaneRoot([root, other], leaf("d").threadRef)).toBe(other);
  expect(selectChatPaneRoot([root], leaf("outside").threadRef)).toBeNull();
  expect(selectChatPaneRoot([root], null)).toBeNull();
});

describe("splitPane", () => {
  it("places the new leaf on the dropped side", () => {
    const root = splitPane(leaf("a"), "a", "left", leaf("b"), "s1");
    expect(root).toMatchObject({
      kind: "split",
      direction: "horizontal",
      first: { id: "b" },
      second: { id: "a" },
    });
    const bottom = splitPane(leaf("a"), "a", "bottom", leaf("b"), "s1");
    expect(bottom).toMatchObject({
      direction: "vertical",
      first: { id: "a" },
      second: { id: "b" },
    });
  });

  it("nests without a cap and wraps a whole layout when the target is its root", () => {
    let root: ChatPaneNode = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    root = splitPane(root, "b", "right", leaf("c"), "s2");
    root = splitPane(root, "s1", "bottom", leaf("d"), "s3");
    expect(collectLeaves(root).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(findNode(root, "s3")).toMatchObject({ direction: "vertical", second: { id: "d" } });
    expect(splitPane(root, "missing", "right", leaf("e"), "s4")).toBe(root);
  });
});

describe("removePane", () => {
  it("collapses the sibling into the parent slot and empties the last leaf", () => {
    const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(removePane(root, "a")).toEqual(leaf("b"));
    expect(removePane(leaf("a"), "a")).toBeNull();
    expect(removePane(root, "missing")).toBe(root);
  });
});

describe("setPaneRatio", () => {
  it("clamps into the allowed range", () => {
    const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(setPaneRatio(root, "s1", 0.05)).toMatchObject({ ratio: 0.2 });
    expect(setPaneRatio(root, "s1", 2)).toMatchObject({ ratio: 0.8 });
    expect(setPaneRatio(root, "nope", 0.3)).toBe(root);
  });
});

describe("resolveDropZone", () => {
  it("prefers the long axis edges and falls back to the short axis in the middle", () => {
    expect(resolveDropZone(rect, 10, 50)).toBe("left");
    expect(resolveDropZone(rect, 290, 50)).toBe("right");
    expect(resolveDropZone(rect, 150, 10)).toBe("top");
    expect(resolveDropZone(rect, 150, 90)).toBe("bottom");
    const tall = { left: 0, top: 0, width: 100, height: 300 };
    expect(resolveDropZone(tall, 50, 10)).toBe("top");
    expect(resolveDropZone(tall, 10, 150)).toBe("left");
    expect(resolveDropZone(rect, -1, 50)).toBeNull();
  });

  it("targets the layout edge only inside the band", () => {
    expect(resolveEdgeDropZone(rect, 150, 5)).toBe("top");
    expect(resolveEdgeDropZone(rect, 295, 50)).toBe("right");
    expect(resolveEdgeDropZone(rect, 150, 50)).toBeNull();
    expect(resolveEdgeDropZone(rect, 310, 50)).toBeNull();
  });
});

it("finds chat panes by thread and panel panes by surface", () => {
  const diff = { ...leaf("a"), id: "a-diff", surface: { id: "diff", kind: "diff" } as const };
  const root = splitPane(leaf("a"), "a", "right", diff, "s1");
  expect(findLeaf(root, leaf("a").threadRef)).toEqual(leaf("a"));
  expect(findLeaf(root, leaf("a").threadRef, "diff")).toEqual(diff);
  expect(findLeaf(root, leaf("a").threadRef, "files")).toBeNull();
});

it("filters hidden leaves for sidebar headers without changing the saved group", () => {
  const root = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
  expect(filterPaneTree(root, () => true)).toBe(root);
  expect(filterPaneTree(root, (pane) => pane.id === "b")).toEqual(leaf("b"));
  expect(filterPaneTree(root, () => false)).toBeNull();
  expect(collectLeaves(root)).toEqual([leaf("a"), leaf("b")]);
});
