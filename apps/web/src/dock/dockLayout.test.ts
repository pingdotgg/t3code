import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_GROUP_ID,
  collectDockGroupIds,
  createDefaultDockTree,
  dockElasticChild,
  insertGroupAtRoot,
  insertGroupBeside,
  parseDockTree,
  PANEL_GROUP_ID,
  pruneDockTree,
  resolveDockTitlebarEdges,
  setDockNodeSizes,
  type DockNode,
} from "./dockLayout";

const tree = createDefaultDockTree();

describe("insertGroupBeside", () => {
  it("adds a sibling when the parent split already runs along the edge", () => {
    const next = insertGroupBeside(tree, PANEL_GROUP_ID, "g1", "left", 200);
    expect(collectDockGroupIds(next)).toEqual([CHAT_GROUP_ID, "g1", "panel"]);
    expect(next.kind === "split" && next.children.at(-1)).toMatchObject({ size: 320 });
  });

  it("wraps the group in a split across the parent, and the split takes over its size", () => {
    const next = insertGroupBeside(tree, PANEL_GROUP_ID, "g1", "bottom", 200);
    expect(next.kind === "split" && next.children.at(-1)).toEqual({
      kind: "split",
      id: "split-g1",
      direction: "column",
      size: 520,
      children: [
        { kind: "group", id: "panel" },
        { kind: "group", id: "g1", size: 200 },
      ],
    });
  });

  it("nests splits so a group can divide in both directions", () => {
    const next = insertGroupBeside(
      insertGroupBeside(tree, PANEL_GROUP_ID, "g1", "bottom", 200),
      "g1",
      "g2",
      "right",
      100,
    );
    expect(collectDockGroupIds(next)).toEqual(["chat", "panel", "g1", "g2"]);
  });
});

describe("insertGroupBeside a split", () => {
  it("joins the split's parent, so the new group runs its full height", () => {
    const stacked = insertGroupBeside(tree, PANEL_GROUP_ID, "b", "bottom", 300);
    const next = insertGroupBeside(stacked, "split-b", "a", "right", 200);
    expect(next.kind === "split" && next.children.map((child) => child.id)).toEqual([
      "chat",
      "split-b",
      "a",
    ]);
    expect(next.kind === "split" && next.children[1]).toMatchObject({ size: 320 });
  });
});

describe("insertGroupAtRoot", () => {
  it("joins a root split along that edge", () => {
    const next = insertGroupAtRoot(tree, "g1", "left", 200);
    expect(collectDockGroupIds(next)[0]).toBe("g1");
    expect(next.kind === "split" && next.direction).toBe("row");
  });

  it("wraps the whole workspace for the other axis", () => {
    const next = insertGroupAtRoot(tree, "g1", "bottom", 200);
    expect(next).toMatchObject({ direction: "column", children: [{ id: "root" }, { id: "g1" }] });
  });
});

describe("pruneDockTree", () => {
  it("folds a split left with one child and hands that child the split's size", () => {
    const split = insertGroupBeside(tree, PANEL_GROUP_ID, "g1", "bottom", 200);
    const next = pruneDockTree(split, new Set(["chat", "g1"]));
    expect(next.kind === "split" && next.children.at(-1)).toEqual({
      kind: "group",
      id: "g1",
      size: 520,
    });
  });

  it("flattens a split folded into a parent of the same direction", () => {
    const nested: DockNode = {
      kind: "split",
      id: "outer",
      direction: "row",
      children: [
        { kind: "group", id: "a" },
        {
          kind: "split",
          id: "middle",
          direction: "column",
          children: [
            { kind: "group", id: "gone" },
            {
              kind: "split",
              id: "inner",
              direction: "row",
              children: [
                { kind: "group", id: "b" },
                { kind: "group", id: "c" },
              ],
            },
          ],
        },
      ],
    };
    expect(pruneDockTree(nested, new Set(["a", "b", "c"]))).toMatchObject({
      id: "outer",
      children: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
  });
});

describe("dockElasticChild", () => {
  it("gives spare room to the chat, wherever it sits", () => {
    const nested = insertGroupBeside(tree, CHAT_GROUP_ID, "g1", "bottom", 200);
    const children = nested.kind === "split" ? nested.children : [];
    expect(dockElasticChild(children)?.id).toBe("split-g1");
  });

  it("falls back to the last child without a chat", () => {
    expect(
      dockElasticChild([
        { kind: "group", id: "a" },
        { kind: "group", id: "b" },
      ])?.id,
    ).toBe("b");
  });
});

describe("resolveDockTitlebarEdges", () => {
  it("skips hidden groups, so the chat owns a corner the panel left", () => {
    const edges = resolveDockTitlebarEdges(tree, new Set(["chat"]));
    expect(edges.left).toBe("chat");
    expect(edges.right).toBe("chat");
  });

  it("leaves a group below a column split out of the title bar", () => {
    const next = insertGroupBeside(tree, PANEL_GROUP_ID, "g1", "bottom", 200);
    const edges = resolveDockTitlebarEdges(next, new Set(["chat", "panel", "g1"]));
    expect([...edges.top]).toEqual(["chat", "panel"]);
    expect(edges.right).toBe("panel");
  });
});

describe("setDockNodeSizes", () => {
  it("resizes splits as well as groups", () => {
    const next = insertGroupBeside(tree, PANEL_GROUP_ID, "g1", "bottom", 200);
    const sized = setDockNodeSizes(next, { "split-g1": 640, g1: 240 });
    expect(sized.kind === "split" && sized.children.at(-1)).toMatchObject({
      size: 640,
      children: [{ id: "panel" }, { id: "g1", size: 240 }],
    });
  });
});

describe("parseDockTree", () => {
  it("rejects malformed trees and duplicate groups instead of rendering them", () => {
    expect(parseDockTree(tree)).toEqual(tree);
    expect(
      parseDockTree({ kind: "split", id: "x", direction: "diagonal", children: [] }),
    ).toBeNull();
    expect(
      parseDockTree({
        kind: "split",
        id: "x",
        direction: "row",
        children: [
          { kind: "group", id: "a" },
          { kind: "group", id: "a" },
        ],
      }),
    ).toBeNull();
  });
});
