import { describe, expect, it, vi } from "vite-plus/test";
import {
  measuredEndOffset,
  settleListScroll,
  startTimelinePositionRestore,
} from "./useTimelinePositionRestore";
import type { LegendListRef } from "@legendapp/list/react";
import type { TimelineViewport } from "./timelineViewport";

it("corrects the measured end on the list's first opening", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  );
  const element = { scrollTop: 2_000, scrollHeight: 5_000, clientHeight: 800 };
  const list = {
    getState: () => ({ data: [] }),
    getScrollableNode: () => element,
    scrollToOffset: async ({ offset }: { offset: number }) => {
      element.scrollTop = offset;
    },
  } as unknown as LegendListRef;
  const viewport = {
    holdProgrammaticScroll: () => () => {},
    subscribe: () => () => {},
  } as unknown as TimelineViewport;
  const stop = startTimelinePositionRestore({
    list,
    viewport,
    listIdentityKey: "first",
    listOpenedOn: "first",
    rememberedPosition: undefined,
    citationPending: false,
    releaseForFind: false,
    onPositioned: () => {},
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(element.scrollTop).toBe(4_200);
  } finally {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe("settleListScroll", () => {
  it("hands off when a streaming reply keeps moving the end", async () => {
    vi.useFakeTimers();
    // The node test environment has no animation frames; fake ones run on the fake clock.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16),
    );
    // Every correction lands, then the reply grows before the next frame.
    const element = { scrollTop: 0, scrollHeight: 5_000, clientHeight: 800 };
    const list = {
      getScrollableNode: () => element as unknown as HTMLElement,
      scrollToOffset: async ({ offset }: { offset: number }) => {
        element.scrollTop = offset;
        element.scrollHeight += 40;
      },
    };

    let settled = false;
    void settleListScroll(list, measuredEndOffset, () => false).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();

    expect(settled).toBe(true);
  });
});
