import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MAIN_CHAT_PANE, chatPaneBounds, closeChatPane, splitChatPane } from "./chatSplitLayout";

const left = ThreadId.make("left");
const right = ThreadId.make("right");
const bottom = ThreadId.make("bottom");
const lower = ThreadId.make("lower");
const far = ThreadId.make("far");

describe("chat split layout", () => {
  it("splits only the target pane vertically and restores it when the new pane closes", () => {
    const columns = splitChatPane(MAIN_CHAT_PANE, null, left, "left");
    const mixed = splitChatPane(columns, left, bottom, "bottom");

    expect(chatPaneBounds(mixed)).toEqual([
      { id: left, left: 0, top: 0, width: 50, height: 50 },
      { id: bottom, left: 0, top: 50, width: 50, height: 50 },
      { id: null, left: 50, top: 0, width: 50, height: 100 },
    ]);
    expect(closeChatPane(mixed, bottom)).toEqual(columns);
  });

  it("shares the available space equally between panes on the same axis", () => {
    const leftSplit = splitChatPane(MAIN_CHAT_PANE, null, left, "left");
    const columns = splitChatPane(leftSplit, null, right, "right");
    expect(chatPaneBounds(columns).map(({ id, width }) => [id, width])).toEqual([
      [left, 100 / 3],
      [null, 100 / 3],
      [right, 100 / 3],
    ]);

    const bottomSplit = splitChatPane(columns, right, bottom, "bottom");
    const nested = splitChatPane(bottomSplit, bottom, lower, "bottom");
    expect(chatPaneBounds(nested).map(({ id, height }) => [id, height])).toEqual([
      [left, 100],
      [null, 100],
      [right, 100 / 3],
      [bottom, 100 / 3],
      [lower, 100 / 3],
    ]);
  });

  it("re-flattens a same-axis group left behind by a closed pane", () => {
    const columns = splitChatPane(
      splitChatPane(splitChatPane(MAIN_CHAT_PANE, null, right, "right"), null, bottom, "bottom"),
      null,
      far,
      "right",
    );
    expect(chatPaneBounds(columns).map(({ id, width }) => [id, width])).toEqual([
      [null, 25],
      [far, 25],
      [bottom, 50],
      [right, 50],
    ]);

    const closed = closeChatPane(columns, bottom);
    expect(closed).not.toBeNull();
    expect(chatPaneBounds(closed!).map(({ id, width }) => [id, width])).toEqual([
      [null, 100 / 3],
      [far, 100 / 3],
      [right, 100 / 3],
    ]);
  });
});
