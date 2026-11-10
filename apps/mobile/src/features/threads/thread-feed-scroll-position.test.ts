import { describe, expect, it } from "vite-plus/test";
import {
  resolveThreadFeedSubmissionAnchor,
  resolveThreadWorkGroupInitialScroll,
  settleThreadFeedJump,
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

  it("does not anchor a follow-up after a user message appears", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: true,
        deliveryDeferred: false,
        queuedMessageCount: 0,
      }),
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

describe("settleThreadFeedJump", () => {
  const landings = (positions: ReadonlyArray<number | undefined>) => {
    let lands = 0;
    return {
      land: async () => {
        lands += 1;
      },
      position: () => positions[Math.min(lands, positions.length - 1)],
      lands: () => lands,
    };
  };

  it("lands again until the measured rows stop moving the target", async () => {
    // The first landing trusts estimated rows; measuring them moves the target.
    const feed = landings([14389, 13563, 13480, 13480]);
    await settleThreadFeedJump({ ...feed, cancelled: () => false });
    expect(feed.lands()).toBe(3);
  });

  it("lands once when the target was already in place", async () => {
    const feed = landings([500, 500]);
    await settleThreadFeedJump({ ...feed, cancelled: () => false });
    expect(feed.lands()).toBe(1);
  });

  it("keeps landing while the target has no position yet", async () => {
    const feed = landings([undefined, 700, 700]);
    await settleThreadFeedJump({ ...feed, cancelled: () => false });
    expect(feed.lands()).toBe(2);
  });

  it("gives up on a target that never settles", async () => {
    const feed = landings(Array.from({ length: 50 }, (_, index) => index * 100));
    await settleThreadFeedJump({ ...feed, cancelled: () => false });
    expect(feed.lands()).toBeLessThan(10);
  });

  it("stops landing once the user takes the scroll", async () => {
    const feed = landings([14389, 13563, 13480]);
    await settleThreadFeedJump({ ...feed, cancelled: () => feed.lands() >= 1 });
    expect(feed.lands()).toBe(1);
  });
});
