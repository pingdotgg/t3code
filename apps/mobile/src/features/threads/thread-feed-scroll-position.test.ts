import { describe, expect, it } from "vite-plus/test";
import {
  resolveThreadFeedSubmissionAnchor,
  resolveThreadWorkGroupInitialScroll,
} from "./thread-feed-scroll-position";

describe("tool-group scroll restoration", () => {
  const position = {
    rowId: "read-output",
    offsetWithinRow: 80,
    scrollOffset: 600,
  };

  it("restores the visible row and its detail offset rather than stale absolute pixels", () => {
    const before = [{ id: "first" }, { id: "read-output" }, { id: "last" }];
    const after = [{ id: "older" }, ...before];
    expect(resolveThreadWorkGroupInitialScroll(before, position)).toEqual({
      index: 1,
      viewOffset: -80,
    });
    expect(resolveThreadWorkGroupInitialScroll(after, position)).toEqual({
      index: 2,
      viewOffset: -80,
    });
  });
});

describe("resolveThreadFeedSubmissionAnchor", () => {
  it("keeps an offline first message at the end", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "offline-first",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
        deliveryDeferred: true,
      }),
    ).toBeNull();
  });

  it("anchors the first user message in a thread", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "first-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        deliveryDeferred: false,
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
        deliveryDeferred: false,
        queuedMessageCount: 1,
      }),
    ).toBe("first-message");
  });

  it("keeps the first message's anchor, not the follow-up's, after a user message appears", () => {
    const followUp = {
      submittedMessageId: "second-message",
      hasStartedTurn: true,
      hasUserMessage: true,
      deliveryDeferred: false,
      queuedMessageCount: 0,
    };
    expect(
      resolveThreadFeedSubmissionAnchor({ ...followUp, currentAnchorMessageId: "first-message" }),
    ).toBe("first-message");
    expect(
      resolveThreadFeedSubmissionAnchor({ ...followUp, currentAnchorMessageId: null }),
    ).toBeNull();
  });

  // regression: #7897 stop pushing follow-up messages to the top
  it("does not anchor a thread that has already started a turn", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "second-message",
        hasStartedTurn: true,
        hasUserMessage: false,
        deliveryDeferred: false,
        queuedMessageCount: 0,
      }),
    ).toBeNull();
  });
});
