import { describe, expect, it } from "vite-plus/test";

import { planPinnedRevealScroll, type PinnedRevealRect } from "./usePinnedSelectionTimeline";

const scrollport = {
  messageId: "message-1",
  messageInEntries: true,
  rowIndex: 4,
  hasMoreHistory: false,
  historyLoading: false,
  historyCursor: "entry-0",
  target: null as PinnedRevealRect | null,
  scrollportTop: 100,
  scrollportHeight: 400,
  scroll: 800,
  scrollHeight: 4000,
  clientHeight: 400,
};

describe("planPinnedRevealScroll", () => {
  it("scrolls down to a pinned message that is below the viewport", () => {
    const plan = planPinnedRevealScroll({
      ...scrollport,
      target: { top: 900, bottom: 980, height: 80 },
    });
    expect(plan).toEqual({ type: "scroll-offset", offset: 1528 });
  });

  it("scrolls up to a pinned message that is above the viewport", () => {
    const plan = planPinnedRevealScroll({
      ...scrollport,
      target: { top: -200, bottom: -120, height: 80 },
    });
    expect(plan).toEqual({ type: "scroll-offset", offset: 428 });
  });

  it("settles when the pinned text is already in view", () => {
    expect(
      planPinnedRevealScroll({
        ...scrollport,
        target: { top: 180, bottom: 260, height: 80 },
      }),
    ).toEqual({ type: "settled" });
  });

  it("scrolls to the row index when the message is virtualized out of the DOM", () => {
    expect(planPinnedRevealScroll(scrollport)).toEqual({ type: "scroll-index", index: 4 });
  });

  it("loads earlier history through the pinned message when it is not mounted", () => {
    expect(
      planPinnedRevealScroll({
        ...scrollport,
        messageInEntries: false,
        rowIndex: -1,
        hasMoreHistory: true,
      }),
    ).toEqual({ type: "load", throughEntryId: "message-1", cursor: "entry-0" });
  });

  it("waits while an earlier page is loading", () => {
    expect(
      planPinnedRevealScroll({
        ...scrollport,
        messageInEntries: false,
        rowIndex: -1,
        hasMoreHistory: true,
        historyLoading: true,
      }),
    ).toEqual({ type: "wait" });
  });
});
