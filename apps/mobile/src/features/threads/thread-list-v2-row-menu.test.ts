import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2RowMenuActions } from "./thread-list-v2-row-menu";

const PRESET_ACTIONS = [
  { id: "snooze:after:60", title: "1 hour", subtitle: "3:00 PM" },
  { id: "snooze:custom", title: "Custom…" },
];

function leafIds(items: ReturnType<typeof buildThreadListV2RowMenuActions>): string[] {
  return items.flatMap((item) => (item.subactions ? leafIds(item.subactions) : [item.id!]));
}

describe("buildThreadListV2RowMenuActions", () => {
  it("matches the active-thread list menu, including regenerate under More", () => {
    const thread = makeThreadShellFixture({
      id: ThreadId.make("thread-1"),
      title: "Start a Conversation",
      branch: "feat/menu",
    });
    const items = buildThreadListV2RowMenuActions({
      thread,
      nested: true,
      settlementSupported: true,
      snoozed: false,
      settled: false,
      includeSnooze: true,
      snoozePresetActions: PRESET_ACTIONS,
      pinningSupported: true,
      reorderSupported: true,
      canMoveUp: true,
      canMoveDown: true,
      titleRegenerationSupported: true,
      canTurnIntoProject: false,
      autoSettleOptOutSupported: true,
    });

    expect(items.map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "copy-thread",
      "copy-thread-id",
      "settle",
      "snooze",
      "pin",
      "more",
    ]);
    const more = items.at(-1);
    expect(more?.subactions?.map((item) => item.id)).toEqual([
      "arrange-menu",
      "rename",
      "regenerate-title",
      "auto-settle",
      "archive",
      "delete",
    ]);
    expect(leafIds(items)).toEqual(
      expect.arrayContaining([
        "regenerate-title",
        "move-up",
        "move-down",
        "arrange",
        "auto-settle:enabled",
        "auto-settle:disabled",
      ]),
    );
  });

  it("keeps regenerate title when flattening for Android", () => {
    const thread = makeThreadShellFixture({ id: ThreadId.make("thread-1"), title: "Flat" });
    const items = buildThreadListV2RowMenuActions({
      thread,
      nested: false,
      settlementSupported: true,
      snoozed: false,
      settled: false,
      includeSnooze: true,
      snoozePresetActions: PRESET_ACTIONS,
      pinningSupported: true,
      reorderSupported: false,
      titleRegenerationSupported: true,
      canTurnIntoProject: false,
      autoSettleOptOutSupported: false,
    });

    expect(items.map((item) => item.id)).toEqual([
      "copy-thread",
      "copy-thread-id",
      "settle",
      "snooze",
      "pin",
      "rename",
      "regenerate-title",
      "archive",
      "delete",
    ]);
  });
});
