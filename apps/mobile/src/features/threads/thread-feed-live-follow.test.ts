import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedSubmissionAnchor,
} from "./thread-feed-live-follow";

describe("resolveThreadFeedSubmissionAnchor", () => {
  it("anchors the first user message in a thread", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "first-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBe("first-message");
  });

  it("preserves the first-message anchor when another message is queued", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 1,
      }),
    ).toBe("first-message");
  });

  it("preserves the first-message anchor after its outbox entry drains", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBe("first-message");
  });

  it("does not anchor a follow-up after a user message appears", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: true,
        queuedMessageCount: 0,
      }),
    ).toBeNull();
  });

  it("does not anchor a thread that has already started a turn", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "second-message",
        hasStartedTurn: true,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBeNull();
  });
});

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

  it.each([
    { isAtEnd: false, userScrollSessionActive: false, expected: false },
    { isAtEnd: true, userScrollSessionActive: false, expected: true },
    { isAtEnd: false, userScrollSessionActive: true, expected: false },
    { isAtEnd: true, userScrollSessionActive: true, expected: false },
  ])("reconciles follow after a disclosure settles: %j", ({ expected, ...state }) => {
    expect(resolveThreadFeedLiveFollow(!expected, { type: "disclosure-settled", ...state })).toBe(
      expected,
    );
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
