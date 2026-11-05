import type { SideChatTreeRow } from "@t3tools/client-runtime/state/thread-relationships";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { layoutSideChatTree } from "./sideChatTreeLayout";

const OPTS = { nodeWidth: 112, nodeHeight: 26, gapX: 32, gapY: 8 };

function row(id: string, parentId: string | null, depth: number): SideChatTreeRow {
  return {
    threadId: ThreadId.make(id),
    parentId: parentId === null ? null : ThreadId.make(parentId),
    depth,
    label: id,
    state: depth === 0 ? "lesson" : "open",
    noteStatus: null,
    section: null,
  };
}

function box(id: string, x: number, y: number) {
  return { threadId: ThreadId.make(id), x, y, width: 112, height: 26 };
}

function edge(from: string, to: string, path: string) {
  return { from: ThreadId.make(from), to: ThreadId.make(to), path };
}

describe("layoutSideChatTree", () => {
  it("gives depths columns and leaves consecutive rows, and centres parents", () => {
    const layout = layoutSideChatTree(
      [
        row("lesson", null, 0),
        row("a", "lesson", 1),
        row("a1", "a", 2),
        row("b", "lesson", 1),
        row("b1", "b", 2),
        row("c", "lesson", 1),
      ],
      OPTS,
    );

    expect(layout.nodes).toEqual([
      box("lesson", 0, 34),
      box("a", 144, 0),
      box("a1", 288, 0),
      box("b", 144, 34),
      box("b1", 288, 34),
      box("c", 144, 68),
    ]);
    expect(layout.edges).toEqual([
      edge("lesson", "a", "M 112 47 C 128 47, 128 13, 144 13"),
      edge("a", "a1", "M 256 13 C 272 13, 272 13, 288 13"),
      edge("lesson", "b", "M 112 47 C 128 47, 128 47, 144 47"),
      edge("b", "b1", "M 256 47 C 272 47, 272 47, 288 47"),
      edge("lesson", "c", "M 112 47 C 128 47, 128 81, 144 81"),
    ]);
    expect([layout.width, layout.height]).toEqual([400, 94]);
  });

  it("centres a parent between its first and last child, not on their mean", () => {
    const layout = layoutSideChatTree(
      [
        row("lesson", null, 0),
        row("a", "lesson", 1),
        row("a1", "a", 2),
        row("a2", "a", 2),
        row("b", "lesson", 1),
        row("c", "lesson", 1),
      ],
      OPTS,
    );

    expect(layout.nodes.map((node) => [node.threadId, node.y])).toEqual([
      ["lesson", 59.5],
      ["a", 17],
      ["a1", 0],
      ["a2", 34],
      ["b", 68],
      ["c", 102],
    ]);
    expect(layout.height).toBe(128);
  });

  it("stays as wide as its depth while a deep tree gains leaves, and grows taller", () => {
    const tree = (branches: number) => [
      row("lesson", null, 0),
      ...Array.from({ length: branches }, (_, index) => `b${index}`).flatMap((id) => [
        row(id, "lesson", 1),
        row(`${id}.1`, id, 2),
        row(`${id}.1.a`, `${id}.1`, 3),
        row(`${id}.1.b`, `${id}.1`, 3),
      ]),
    ];
    const few = layoutSideChatTree(tree(2), OPTS);
    const many = layoutSideChatTree(tree(8), OPTS);

    expect(few.width).toBe(4 * 112 + 3 * 32);
    expect(many.width).toBe(few.width);
    expect(few.height).toBe(4 * 34 - 8);
    expect(many.height).toBe(16 * 34 - 8);
  });

  it("lays out a lone lesson, an empty tree and a row whose parent is missing", () => {
    expect(layoutSideChatTree([row("lesson", null, 0)], OPTS)).toEqual({
      nodes: [box("lesson", 0, 0)],
      edges: [],
      width: 112,
      height: 26,
    });
    expect(layoutSideChatTree([], OPTS)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });

    const stray = layoutSideChatTree([row("lesson", null, 0), row("stray", "gone", 1)], OPTS);
    expect(stray.nodes[1]).toEqual(box("stray", 144, 34));
    expect(stray.edges).toEqual([]);
  });
});
