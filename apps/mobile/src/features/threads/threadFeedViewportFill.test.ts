import { describe, expect, it } from "vite-plus/test";

import {
  shouldAutoloadEarlierHistory,
  threadFeedUnderfillsViewport,
} from "./threadFeedViewportFill";

// iPhone 17 Pro thread feed: content including the composer inset is shorter
// than the list frame, so the page cannot scroll past a rubber-band.
const scrollLength = 874;
const underfilledContent = 835.79;
const filledContent = 1_400;

describe("threadFeedUnderfillsViewport", () => {
  it("is underfilled when content is shorter than the viewport", () => {
    expect(threadFeedUnderfillsViewport({ contentLength: underfilledContent, scrollLength })).toBe(
      true,
    );
    expect(threadFeedUnderfillsViewport({ contentLength: filledContent, scrollLength })).toBe(
      false,
    );
  });

  it("ignores empty layout measurements", () => {
    expect(threadFeedUnderfillsViewport({ contentLength: 0, scrollLength })).toBe(false);
    expect(
      threadFeedUnderfillsViewport({ contentLength: underfilledContent, scrollLength: 0 }),
    ).toBe(false);
  });
});

describe("shouldAutoloadEarlierHistory", () => {
  const underfill = {
    hasMoreHistory: true,
    loading: false,
    error: null as string | null,
    contentLength: underfilledContent,
    scrollLength,
  };

  it("loads earlier history while the page underfills and more remains", () => {
    expect(shouldAutoloadEarlierHistory(underfill)).toBe(true);
  });

  it("stops when the viewport is filled, history is exhausted, or a load is in flight", () => {
    expect(shouldAutoloadEarlierHistory({ ...underfill, contentLength: filledContent })).toBe(
      false,
    );
    expect(shouldAutoloadEarlierHistory({ ...underfill, hasMoreHistory: false })).toBe(false);
    expect(shouldAutoloadEarlierHistory({ ...underfill, loading: true })).toBe(false);
    expect(shouldAutoloadEarlierHistory({ ...underfill, error: "Couldn't load" })).toBe(false);
  });

  it("defers to jump paging and active user scrolls", () => {
    expect(shouldAutoloadEarlierHistory({ ...underfill, jumpToMessageActive: true })).toBe(false);
    expect(shouldAutoloadEarlierHistory({ ...underfill, userScrollSessionActive: true })).toBe(
      false,
    );
  });
});
