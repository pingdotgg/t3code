import type { SideChatTreeRow } from "@t3tools/client-runtime/state/thread-relationships";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fitSideChatMapScale,
  groupSideChatMapRows,
  resolveSideChatMapKeyTarget,
  sideChatMapNodeDescription,
  sideChatMapNodeStatus,
} from "./SideChatMap.logic";

function row(
  id: string,
  parentId: string | null,
  depth: number,
  state: SideChatTreeRow["state"] = depth === 0 ? "lesson" : "open",
  noteStatus: SideChatTreeRow["noteStatus"] = null,
  section: string | null = null,
): SideChatTreeRow {
  return {
    threadId: ThreadId.make(id),
    parentId: parentId === null ? null : ThreadId.make(parentId),
    depth,
    label: id,
    state,
    noteStatus,
    section,
  };
}

const rows = [
  row("lesson", null, 0),
  row("a", "lesson", 1),
  row("a1", "a", 2),
  row("b", "lesson", 1),
  row("b1", "b", 2),
  row("c", "lesson", 1),
];

function keyTarget(from: string, key: string): string | null {
  return resolveSideChatMapKeyTarget(rows, ThreadId.make(from), key);
}

describe("resolveSideChatMapKeyTarget", () => {
  it("moves to the parent, the first child and the neighbouring siblings", () => {
    expect(keyTarget("a", "ArrowLeft")).toBe("lesson");
    expect(keyTarget("a", "ArrowRight")).toBe("a1");
    expect(keyTarget("a", "ArrowDown")).toBe("b");
    expect(keyTarget("b", "ArrowUp")).toBe("a");
    expect(keyTarget("c", "ArrowUp")).toBe("b");
  });

  it("stops at the edges instead of wrapping", () => {
    expect(keyTarget("a", "ArrowUp")).toBeNull();
    expect(keyTarget("c", "ArrowDown")).toBeNull();
    expect(keyTarget("lesson", "ArrowLeft")).toBeNull();
    expect(keyTarget("lesson", "ArrowDown")).toBeNull();
    expect(keyTarget("a1", "ArrowDown")).toBeNull();
    expect(keyTarget("a1", "ArrowRight")).toBeNull();
  });

  it("goes from the lesson to its first side chat", () => {
    expect(keyTarget("lesson", "ArrowRight")).toBe("a");
  });

  it("ignores other keys and threads that are not in the map", () => {
    expect(keyTarget("a", "Enter")).toBeNull();
    expect(keyTarget("a", "Tab")).toBeNull();
    expect(keyTarget("gone", "ArrowRight")).toBeNull();
  });
});

describe("groupSideChatMapRows", () => {
  it("keeps unsectioned chats first, groups sections in order, and shifts subtrees", () => {
    const input = [
      row("lesson", null, 0),
      row("plain", "lesson", 1),
      row("a", "lesson", 1, "open", null, "Lesson 1: first"),
      row("a1", "a", 2),
      row("b", "lesson", 1, "open", null, "U2: second"),
    ];
    expect(
      groupSideChatMapRows(input).map(({ threadId, parentId, depth, label }) => [
        threadId,
        parentId,
        depth,
        label,
      ]),
    ).toEqual([
      [ThreadId.make("lesson"), null, 0, "lesson"],
      [ThreadId.make("plain"), ThreadId.make("lesson"), 1, "plain"],
      [ThreadId.make("section:Lesson 1: first"), ThreadId.make("lesson"), 1, "Lesson 1: first"],
      [ThreadId.make("a"), ThreadId.make("section:Lesson 1: first"), 2, "a"],
      [ThreadId.make("a1"), ThreadId.make("a"), 3, "a1"],
      [ThreadId.make("section:U2: second"), ThreadId.make("lesson"), 1, "U2: second"],
      [ThreadId.make("b"), ThreadId.make("section:U2: second"), 2, "b"],
    ]);
  });

  it("leaves a no-section input unchanged and hides a collapsed subtree", () => {
    const input = [row("lesson", null, 0), row("a", "lesson", 1)];
    expect(groupSideChatMapRows(input)).toEqual(input);
    const section = row("a", "lesson", 1, "open", null, "Lesson 1: first");
    const child = row("a1", "a", 2);
    const collapsed = groupSideChatMapRows(
      [row("lesson", null, 0), section, child],
      new Set([ThreadId.make("section:Lesson 1: first")]),
    );
    expect(collapsed.map((entry) => entry.threadId)).toEqual([
      ThreadId.make("lesson"),
      ThreadId.make("section:Lesson 1: first"),
    ]);
    expect(collapsed[1]?.label).toBe("Lesson 1: first (2)");
  });
});

describe("sideChatMapNodeStatus and sideChatMapNodeDescription", () => {
  it.each([
    { name: "lesson", state: "lesson", noteStatus: null, status: null, description: "Lesson" },
    { name: "open", state: "open", noteStatus: null, status: "in_progress", description: "Open" },
    {
      name: "done, writing the note",
      state: "done",
      noteStatus: "generating",
      status: "pending",
      description: "Done, writing note",
    },
    {
      name: "done, note failed",
      state: "done",
      noteStatus: "failed",
      status: "failed",
      description: "Done, couldn't write the note",
    },
    {
      name: "done, note ready",
      state: "done",
      noteStatus: "ready",
      status: "completed",
      description: "Done, note ready",
    },
    {
      name: "done, no note needed",
      state: "done",
      noteStatus: "none",
      status: "completed",
      description: "Done, no note needed",
    },
    {
      name: "done, no note status",
      state: "done",
      noteStatus: null,
      status: null,
      description: "Done",
    },
  ] as const)("$name", ({ state, noteStatus, status, description }) => {
    const node = row("x", "lesson", 1, state, noteStatus);
    expect(sideChatMapNodeStatus(node)).toBe(status);
    expect(sideChatMapNodeDescription(node)).toBe(description);
  });
});

describe("fitSideChatMapScale", () => {
  it("shrinks wide content to the available width and never enlarges it", () => {
    expect(fitSideChatMapScale(472, 236)).toBe(0.5);
    expect(fitSideChatMapScale(352, 600)).toBe(1);
  });

  it("stays at full size until a width is known", () => {
    expect(fitSideChatMapScale(0, 236)).toBe(1);
    expect(fitSideChatMapScale(472, 0)).toBe(1);
  });
});
