import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedReflowAnchor,
  resolveThreadFeedReflowOffset,
  resolveThreadFeedReflowScroll,
  resolveThreadFeedSubmissionAnchor,
  resolveThreadWorkGroupInitialScroll,
  shouldFollowThreadWorkGroupAppend,
} from "./thread-feed-live-follow";

describe("tool-group scroll restoration", () => {
  const position = {
    rowId: "read-output",
    offsetWithinRow: 80,
    scrollOffset: 600,
    contentHeight: 1_000,
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

describe("tool-group append following", () => {
  const previousRows = Array.from({ length: 10 }, (_, index) => ({ id: `call-${index}` }));
  const appendedRows = [...previousRows, { id: "new-call" }];
  const atEnd = {
    previousRows,
    rows: appendedRows,
    previousContentHeight: 289,
    contentHeight: 318,
    viewportHeight: 256,
    scrollOffset: 33,
    detailsChanged: false,
    userScrolling: false,
  };

  it("follows a new call when the reader was at the end", () => {
    expect(shouldFollowThreadWorkGroupAppend(atEnd)).toBe(true);
  });

  it("follows the first overflowing append as a short group reaches its height cap", () => {
    expect(
      shouldFollowThreadWorkGroupAppend({
        ...atEnd,
        previousRows: previousRows.slice(0, 8),
        rows: previousRows.slice(0, 9),
        previousContentHeight: 231,
        contentHeight: 260,
        viewportHeight: 231,
        scrollOffset: 0,
      }),
    ).toBe(true);
  });

  it.each([
    { name: "reading earlier calls", changes: { scrollOffset: 20 } },
    { name: "streaming a result", changes: { rows: previousRows, contentHeight: 600 } },
    {
      name: "replacing a call while appending",
      changes: { rows: [{ id: "replacement" }, ...appendedRows.slice(1)] },
    },
  ])("does not steal the reader's position when $name", ({ changes }) => {
    expect(shouldFollowThreadWorkGroupAppend({ ...atEnd, ...changes })).toBe(false);
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

describe("resolveThreadFeedLiveFollow", () => {
  // regression: #5986 stabilize thread composer and interactions
  it("pauses immediately when the user starts scrolling", () => {
    expect(resolveThreadFeedLiveFollow(true, { type: "user-scroll-begin" })).toBe(false);
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
});

describe("width reflow anchors", () => {
  const layout = { rowsTop: 50, headerInset: 100 };
  const feedState = (
    rows: ReadonlyArray<{ readonly id: string; readonly size: number }>,
    scroll: number,
    isWithinMaintainScrollAtEndThreshold = false,
  ) => {
    const positions = rows.map((_, index) =>
      rows.slice(0, index).reduce((top, row) => top + row.size, 0),
    );
    return {
      data: rows,
      scroll,
      isWithinMaintainScrollAtEndThreshold,
      indexByKey: (key: string) => {
        const index = rows.findIndex((row) => row.id === key);
        return index < 0 ? undefined : index;
      },
      positionAtIndex: (index: number) => positions[index],
      sizes: new Map(rows.map((row) => [row.id, row.size])),
    };
  };
  const wide = [
    { id: "question", size: 400 },
    { id: "reply", size: 2_000 },
    { id: "follow-up", size: 300 },
  ];
  // The line under the header sits 1,200px, 60%, into the reply.
  const readingReply = feedState(wide, 1_550);

  it("keeps the end for a feed that is following it", () => {
    expect(resolveThreadFeedReflowAnchor(feedState(wide, 1_550, true), layout, true)).toBe("end");
  });

  it("keeps the reader's row after a status-bar scroll left follow on far from the end", () => {
    expect(resolveThreadFeedReflowAnchor(readingReply, layout, true)).toEqual({
      key: "reply",
      offsetWithinRow: 1_200,
      size: 2_000,
    });
  });

  it.each([
    { change: "narrows", replySize: 4_000 },
    { change: "widens", replySize: 1_000 },
  ])("keeps the reader 60% into a reply when the feed $change", ({ replySize }) => {
    const anchor = resolveThreadFeedReflowAnchor(readingReply, layout, false);
    if (anchor === null || anchor === "end") throw new Error("expected a row anchor");
    const reflowed = feedState(
      [
        { id: "question", size: 400 * (replySize / 2_000) },
        { id: "reply", size: replySize },
        { id: "follow-up", size: 300 },
      ],
      readingReply.scroll,
    );
    expect(resolveThreadFeedReflowScroll(anchor, reflowed, layout)).toEqual({
      index: 1,
      viewOffset: layout.headerInset - 0.6 * replySize,
    });
  });

  it.each([
    { change: "narrows", replySize: 4_000 },
    { change: "widens", replySize: 1_000 },
  ])(
    "holds the reader 60% into a reply on each re-measure as the feed $change",
    ({ replySize }) => {
      const anchor = resolveThreadFeedReflowAnchor(readingReply, layout, false);
      if (anchor === null || anchor === "end") throw new Error("expected a row anchor");
      const rows = [
        { id: "question", size: 400 * (replySize / 2_000) },
        { id: "reply", size: replySize },
        { id: "follow-up", size: 300 },
      ];
      const offset = resolveThreadFeedReflowOffset(
        anchor,
        feedState(rows, readingReply.scroll),
        layout,
      );
      if (offset === undefined) throw new Error("expected an offset");
      expect(resolveThreadFeedReflowAnchor(feedState(rows, offset), layout, false)).toEqual({
        key: "reply",
        offsetWithinRow: 0.6 * replySize,
        size: replySize,
      });
    },
  );

  it("leaves a reader at the top of the thread where they are", () => {
    expect(resolveThreadFeedReflowAnchor(feedState(wide, -layout.headerInset), layout, false)).toBe(
      null,
    );
  });

  it("does not scroll when the row did not change size", () => {
    const anchor = resolveThreadFeedReflowAnchor(readingReply, layout, false);
    if (anchor === null || anchor === "end") throw new Error("expected a row anchor");
    expect(resolveThreadFeedReflowScroll(anchor, readingReply, layout)).toBeNull();
  });

  it("does not restore a row that left the feed", () => {
    expect(
      resolveThreadFeedReflowScroll(
        { key: "reply", offsetWithinRow: 1_200, size: 2_000 },
        feedState([{ id: "question", size: 400 }], 0),
        layout,
      ),
    ).toBeNull();
  });
});
