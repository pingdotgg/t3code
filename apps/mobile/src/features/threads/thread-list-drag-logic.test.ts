import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { draggableThreadKeys, snapshotRows } from "./thread-list-drag-logic";
import { resolveThreadDrop } from "./threadDragGap";

const environmentId = EnvironmentId.make("env");
const thread = (key: string, pinned = false) => ({
  type: "v2-thread",
  key,
  item: {
    thread: { environmentId, id: ThreadId.make(key) },
    pinned,
    snoozed: false,
    variant: "card",
  },
});
const pending = { type: "v2-pending", key: "pending" };
const shelf = { type: "v2-working-shelf", key: "working" };
const state = { positionAtIndex: (index: number) => index * 60, sizes: new Map<string, number>() };

describe("pending rows in the live drag block", () => {
  it("keeps live threads draggable and valid drop targets after leading creation rows", () => {
    const items = [pending, thread("pin", true), thread("active")];
    expect([...draggableThreadKeys(items)]).toEqual(["pin", "active"]);
    const { rows, offsets } = snapshotRows(state, items, 60);
    expect(offsets).toEqual({ pending: 0, pin: 60, active: 120 });
    const drop = (contentY: number) =>
      resolveThreadDrop({
        rows,
        contentY,
        source: {
          threadKey: scopedThreadKey(environmentId, ThreadId.make("active")),
          section: "active",
        },
        canDrop: () => true,
      });
    expect(drop(20)).toBeNull();
    expect(drop(70)).toEqual({
      section: "pinned",
      targetId: scopedThreadKey(environmentId, ThreadId.make("pin")),
      placement: "before",
    });
    expect(rows.map((row) => row.section)).toEqual([null, "pinned", "active"]);
  });

  it("does not reopen the live block for pending or thread rows after a shelf", () => {
    const items = [
      pending,
      thread("active"),
      shelf,
      { ...pending, key: "later" },
      thread("parked"),
    ];
    expect([...draggableThreadKeys(items)]).toEqual(["active"]);
    expect(snapshotRows(state, items, 60).rows.map((row) => row.section)).toEqual([
      null,
      "active",
      null,
      null,
      null,
    ]);
  });
});
