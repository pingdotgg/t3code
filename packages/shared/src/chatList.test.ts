import { describe, expect, it } from "vite-plus/test";

import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "./chatList.ts";

interface Row {
  readonly kind: string;
  readonly id: string | null;
}

const rows: ReadonlyArray<Row> = [
  { kind: "message", id: "first" },
  { kind: "divider", id: null },
  { kind: "message", id: "second" },
  { kind: "divider", id: null },
  { kind: "message", id: "third" },
];

const anchorIdOf = (row: Row) => (row.kind === "message" ? row.id : null);

describe("resolveChatListAnchoredEndSpace", () => {
  it("finds the anchor past earlier anchored items", () => {
    expect(resolveChatListAnchoredEndSpace(rows, "third", anchorIdOf)).toEqual({
      anchorIndex: 4,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
    expect(resolveChatListAnchoredEndSpace(rows, "second", anchorIdOf)).toEqual({
      anchorIndex: 2,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
  });

  it("honors a custom anchor offset", () => {
    expect(
      resolveChatListAnchoredEndSpace(rows, "second", anchorIdOf, { anchorOffset: 3 }),
    ).toEqual({ anchorIndex: 2, anchorOffset: 3 });
  });

  it("returns undefined without an anchor or a matching item", () => {
    expect(resolveChatListAnchoredEndSpace(rows, null, anchorIdOf)).toBeUndefined();
    expect(resolveChatListAnchoredEndSpace(rows, "missing", anchorIdOf)).toBeUndefined();
  });
});
