import { describe, expect, it } from "vite-plus/test";
import { threadDragAction, threadOrderAfterMove } from "./threadOrder";
import {
  resolveThreadDrop,
  threadDragGapOffset,
  threadDropInsertionOffset,
  type ThreadDragRow,
} from "./threadDragGap";

describe("live thread insertion gap", () => {
  // Header, pinned row, Active header, two active rows. Geometry stays fixed for hit testing.
  const offsets = [0, 48, 120, 168, 240];
  const shifts = (source: number, insertion: number) =>
    offsets.map((offset) => threadDragGapOffset(offset, source, 72, insertion));

  it("moves the Active header and intervening rows up when unpinning", () => {
    expect(shifts(48, 312)).toEqual([0, 0, -72, -72, -72]);
  });
  it("opens a full gap below the Pinned header when pinning", () => {
    expect(shifts(240, 48)).toEqual([0, 72, 72, 72, 0]);
  });
  it("leaves the source gap in place for cancellation or its current destination", () => {
    expect(shifts(168, 168)).toEqual([0, 0, 0, 0, 0]);
    expect(shifts(168, 240)).toEqual([0, 0, 0, 0, 0]);
  });
  it("moves only crossed rows for an adjacent reorder", () => {
    expect(shifts(168, 312)).toEqual([0, 0, 0, 0, -72]);
    expect(shifts(240, 168)).toEqual([0, 0, 0, 72, 0]);
  });
});

describe("drag action labels", () => {
  it("names the action for each destination instead of its section", () => {
    expect(threadDragAction("active", "pinned")).toBe("Pin");
    expect(threadDragAction("pinned", "active")).toBe("Unpin");
    expect(threadDragAction("settled", "active")).toBe("Unsettle");
    expect(threadDragAction("snoozed", "active")).toBe("Unsnooze");
    expect(threadDragAction("active", "settled")).toBe("Settle");
    expect(threadDragAction("pinned", "settled")).toBe("Settle");
    expect(threadDragAction("active", "active")).toBe("Reorder");
  });
  it("does not offer a parked-section reorder or snooze without a wake time", () => {
    expect(threadDragAction("settled", "settled")).toBeNull();
    expect(threadDragAction("active", "snoozed")).toBeNull();
    expect(
      threadOrderAfterMove(["a", "b"], "a", {
        section: "settled",
        targetId: null,
        placement: "before",
      }),
    ).toBeNull();
  });
});

describe("thread list drop targets", () => {
  // Mixed-height Home rows: one pin, two active cards, a queued task, then Settled.
  const rows: ThreadDragRow[] = [
    { key: "p1", threadKey: "env:p1", section: "pinned", offset: 0, height: 80 },
    { key: "a1", threadKey: "env:a1", section: "active", offset: 80, height: 90 },
    { key: "a2", threadKey: "env:a2", section: "active", offset: 170, height: 80 },
    { key: "queued", threadKey: null, section: null, offset: 250, height: 50 },
    { key: "settled-shelf", threadKey: null, section: "settled", offset: 300, height: 40 },
    { key: "s1", threadKey: "env:s1", section: "settled", offset: 340, height: 60 },
  ];
  const drop = (contentY: number, canDrop: () => boolean = () => true) =>
    resolveThreadDrop({
      rows,
      contentY,
      source: { threadKey: "env:a1", section: "active" },
      canDrop,
    });

  it("places by the hovered row's midpoint across sections", () => {
    expect(drop(20)).toEqual({ section: "pinned", targetId: "env:p1", placement: "before" });
    expect(drop(60)).toEqual({ section: "pinned", targetId: "env:p1", placement: "after" });
    expect(drop(240)).toEqual({ section: "active", targetId: "env:a2", placement: "after" });
  });
  it("offers no move over the source, queued tasks, or a refused plan", () => {
    expect(drop(120)).toBeNull();
    expect(drop(270)).toBeNull();
    expect(drop(200, () => false)).toBeNull();
  });
  it("settles anywhere over the Settled shelf and clamps past the end", () => {
    const settle = { section: "settled", targetId: null, placement: "before" };
    expect(drop(310)).toEqual(settle);
    expect(drop(900)).toEqual(settle);
  });
  it("opens the gap at the destination row's edge, or not at all", () => {
    expect(threadDropInsertionOffset(rows, drop(60), 80)).toBe(80);
    expect(threadDropInsertionOffset(rows, drop(240), 80)).toBe(250);
    expect(threadDropInsertionOffset(rows, drop(310), 80)).toBe(80);
    expect(threadDropInsertionOffset(rows, null, 80)).toBe(80);
  });
});
