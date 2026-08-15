import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedAtEndState,
  shouldShowThreadFeedScrollToEnd,
} from "./thread-feed-live-follow";

describe("resolveThreadFeedLiveFollow", () => {
  it("pauses immediately when the user starts scrolling", () => {
    expect(resolveThreadFeedLiveFollow(true, { type: "user-scroll-begin" })).toBe(false);
  });

  it("stays paused away from the actual end", () => {
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "scroll",
        isAtEnd: false,
        userScrollSessionActive: true,
      }),
    ).toBe(false);
  });

  it("does not mistake programmatic layout compensation for a user scroll", () => {
    expect(
      resolveThreadFeedLiveFollow(true, {
        type: "scroll",
        isAtEnd: false,
        userScrollSessionActive: false,
      }),
    ).toBe(true);
  });

  it("does not re-arm at the end while a user scroll session is active", () => {
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "scroll",
        isAtEnd: true,
        userScrollSessionActive: true,
      }),
    ).toBe(false);
  });

  it("re-arms at the actual end only after the user scroll session ends", () => {
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "user-scroll-end",
        isAtEnd: true,
        userScrollSessionActive: true,
      }),
    ).toBe(true);
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "user-scroll-end",
        isAtEnd: false,
        userScrollSessionActive: true,
      }),
    ).toBe(false);
  });

  it("ignores momentum-end events from programmatic scrolling", () => {
    expect(
      resolveThreadFeedLiveFollow(true, {
        type: "user-scroll-end",
        isAtEnd: false,
        userScrollSessionActive: false,
      }),
    ).toBe(true);
  });

  it("re-arms after an explicit reset", () => {
    expect(resolveThreadFeedLiveFollow(false, { type: "reset" })).toBe(true);
  });
});

describe("shouldShowThreadFeedScrollToEnd", () => {
  it("stays hidden when a drag starts at the actual end", () => {
    expect(
      shouldShowThreadFeedScrollToEnd({
        endFollowEnabled: false,
        isAtEnd: true,
      }),
    ).toBe(false);
  });

  it("appears only after the feed moves away from the actual end", () => {
    expect(
      shouldShowThreadFeedScrollToEnd({
        endFollowEnabled: false,
        isAtEnd: false,
      }),
    ).toBe(true);
  });

  it("stays hidden while live follow is enabled", () => {
    expect(
      shouldShowThreadFeedScrollToEnd({
        endFollowEnabled: true,
        isAtEnd: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadFeedAtEndState", () => {
  it("resets at-end state when returning to a previously scrolled thread", () => {
    const threadAAwayFromEnd = {
      threadKey: "thread-a",
      isAtEnd: false,
    } as const;
    const threadBAtEnd = resolveThreadFeedAtEndState(threadAAwayFromEnd, "thread-b");

    expect(threadBAtEnd).toEqual({ threadKey: "thread-b", isAtEnd: true });
    expect(resolveThreadFeedAtEndState(threadBAtEnd, "thread-a")).toEqual({
      threadKey: "thread-a",
      isAtEnd: true,
    });
  });
});
