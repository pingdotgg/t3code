import { describe, expect, it } from "vite-plus/test";

import {
  shouldAutoloadEarlierHistory,
  shouldShowLoadEarlierControl,
  threadFeedAlignEndPadding,
  threadFeedLayoutReady,
  threadFeedUnderfillsViewport,
} from "./threadFeedViewportFill";

// iPhone 17 Pro thread feed: content including the composer inset is shorter
// than the list frame, so the page cannot scroll past a rubber-band.
const scrollLength = 874;
const underfilledContent = 835.79;
const filledContent = 1_400;
const headerInset = 116;

describe("threadFeedAlignEndPadding", () => {
  it("measures white space between the list header and the first row", () => {
    expect(
      threadFeedAlignEndPadding({
        firstItemPosition: 220,
        headerSize: 48,
        stylePaddingTop: 12,
      }),
    ).toBe(160);
    expect(
      threadFeedAlignEndPadding({
        firstItemPosition: 60,
        headerSize: 48,
        stylePaddingTop: 12,
      }),
    ).toBe(0);
  });
});

describe("threadFeedLayoutReady", () => {
  it("needs a positive frame and content size", () => {
    expect(threadFeedLayoutReady({ contentLength: 0, scrollLength })).toBe(false);
    expect(threadFeedLayoutReady({ contentLength: underfilledContent, scrollLength: 0 })).toBe(
      false,
    );
    expect(threadFeedLayoutReady({ contentLength: underfilledContent, scrollLength })).toBe(true);
  });
});

describe("threadFeedUnderfillsViewport", () => {
  it("is underfilled when the first row sits below the header at the resting end", () => {
    expect(
      threadFeedUnderfillsViewport({
        contentLength: filledContent,
        scrollLength,
        firstItemScreenOffset: 280,
        contentInsetStart: headerInset,
      }),
    ).toBe(true);
    expect(
      threadFeedUnderfillsViewport({
        contentLength: filledContent,
        scrollLength,
        firstItemScreenOffset: -40,
        contentInsetStart: headerInset,
      }),
    ).toBe(false);
  });

  it("is underfilled when end-alignment left white space above the turns", () => {
    expect(
      threadFeedUnderfillsViewport({
        contentLength: filledContent,
        scrollLength,
        alignItemsAtEndPadding: 160,
      }),
    ).toBe(true);
    expect(
      threadFeedUnderfillsViewport({
        contentLength: filledContent,
        scrollLength,
        alignItemsAtEndPadding: 0,
      }),
    ).toBe(false);
  });

  it("is underfilled when content is shorter than the viewport", () => {
    expect(
      threadFeedUnderfillsViewport({
        contentLength: underfilledContent,
        scrollLength,
        contentInsetStart: headerInset,
      }),
    ).toBe(true);
    expect(
      threadFeedUnderfillsViewport({
        contentLength: filledContent,
        scrollLength,
        contentInsetStart: headerInset,
      }),
    ).toBe(false);
  });

  it("is underfilled when end-align spacer makes contentLength match the frame", () => {
    expect(
      threadFeedUnderfillsViewport({
        contentLength: scrollLength,
        scrollLength,
        contentInsetStart: headerInset,
      }),
    ).toBe(true);
  });

  it("ignores empty layout measurements without end-alignment padding", () => {
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
    contentInsetStart: headerInset,
  };

  it("loads earlier history while the page underfills and more remains", () => {
    expect(shouldAutoloadEarlierHistory(underfill)).toBe(true);
    expect(
      shouldAutoloadEarlierHistory({
        ...underfill,
        contentLength: scrollLength,
      }),
    ).toBe(true);
    expect(
      shouldAutoloadEarlierHistory({
        ...underfill,
        contentLength: filledContent,
        firstItemScreenOffset: 300,
      }),
    ).toBe(true);
  });

  it("stops when the viewport is filled, history is exhausted, or a load is in flight", () => {
    expect(
      shouldAutoloadEarlierHistory({
        ...underfill,
        contentLength: filledContent,
        firstItemScreenOffset: -20,
      }),
    ).toBe(false);
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

describe("shouldShowLoadEarlierControl", () => {
  const pastFold = {
    hasMoreHistory: true,
    error: null as string | null,
    underfillsViewport: false,
    layoutReady: true,
    scrollRange: 200,
    firstItemScreenOffset: 40,
    contentInsetStart: headerInset,
  };

  it("hides the control while the feed still underfills the viewport", () => {
    expect(
      shouldShowLoadEarlierControl({
        ...pastFold,
        underfillsViewport: true,
      }),
    ).toBe(false);
  });

  it("hides the control until layout is past the fold so it does not flash under the title", () => {
    expect(
      shouldShowLoadEarlierControl({
        ...pastFold,
        layoutReady: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLoadEarlierControl({
        ...pastFold,
        scrollRange: 8,
      }),
    ).toBe(false);
    expect(
      shouldShowLoadEarlierControl({
        ...pastFold,
        firstItemScreenOffset: 280,
      }),
    ).toBe(false);
  });

  it("shows the control once the feed fills past the fold, or when a load error needs a retry", () => {
    expect(shouldShowLoadEarlierControl(pastFold)).toBe(true);
    expect(
      shouldShowLoadEarlierControl({
        ...pastFold,
        error: "Couldn't load",
        underfillsViewport: true,
        scrollRange: 0,
      }),
    ).toBe(true);
    expect(
      shouldShowLoadEarlierControl({
        ...pastFold,
        hasMoreHistory: false,
      }),
    ).toBe(false);
  });
});
