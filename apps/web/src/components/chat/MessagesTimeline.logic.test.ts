import { describe, expect, it } from "vitest";
import { type MessageId } from "@t3tools/contracts";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import {
  computeActiveMinimapIndex,
  selectUserMessageMinimapEntries,
  selectVisibleMinimapEntries,
  type MinimapListStateSnapshot,
  type MinimapUserMessageEntry,
} from "./ChatMinimap.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-final-entry",
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
    expect(assistantRows[1]?.showCompletionDivider).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});

describe("selectUserMessageMinimapEntries", () => {
  it("returns an empty array when no rows are present", () => {
    expect(selectUserMessageMinimapEntries([])).toEqual([]);
  });

  it("returns an empty array when no rows are user messages", () => {
    const rows: MessagesTimelineRow[] = [
      {
        kind: "message",
        id: "entry-a1",
        createdAt: "2026-01-01T00:00:10Z",
        message: {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Hello",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:10Z",
          completedAt: "2026-01-01T00:00:11Z",
          streaming: false,
        },
        durationStart: "2026-01-01T00:00:10Z",
        showCompletionDivider: false,
        showAssistantCopyButton: false,
      },
      {
        kind: "work",
        id: "entry-work-1",
        createdAt: "2026-01-01T00:00:05Z",
        groupedEntries: [
          {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            label: "thinking",
            tone: "thinking",
          },
        ],
      },
    ];

    expect(selectUserMessageMinimapEntries(rows)).toEqual([]);
  });

  it("captures the original rowIndex for user message rows in a mixed list", () => {
    const rows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "entry-work-1",
        createdAt: "2026-01-01T00:00:00Z",
        groupedEntries: [
          {
            id: "work-1",
            createdAt: "2026-01-01T00:00:00Z",
            label: "thinking",
            tone: "thinking",
          },
        ],
      },
      {
        kind: "message",
        id: "entry-user-1",
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "user-1" as never,
          role: "user",
          text: "First message",
          turnId: null,
          createdAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
        durationStart: "2026-01-01T00:00:05Z",
        showCompletionDivider: false,
        showAssistantCopyButton: false,
      },
      {
        kind: "message",
        id: "entry-a1",
        createdAt: "2026-01-01T00:00:10Z",
        message: {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Reply",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:10Z",
          completedAt: "2026-01-01T00:00:11Z",
          streaming: false,
        },
        durationStart: "2026-01-01T00:00:05Z",
        showCompletionDivider: false,
        showAssistantCopyButton: true,
      },
      {
        kind: "message",
        id: "entry-user-2",
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "user-2" as never,
          role: "user",
          text: "Second message",
          turnId: null,
          createdAt: "2026-01-01T00:00:20Z",
          streaming: false,
        },
        durationStart: "2026-01-01T00:00:20Z",
        showCompletionDivider: false,
        showAssistantCopyButton: false,
      },
    ];

    const entries = selectUserMessageMinimapEntries(rows);
    expect(entries).toEqual([
      {
        rowIndex: 1,
        rowKey: "entry-user-1",
        messageId: "user-1",
        previewText: "First message",
      },
      {
        rowIndex: 3,
        rowKey: "entry-user-2",
        messageId: "user-2",
        previewText: "Second message",
      },
    ]);
  });

  it("strips trailing terminal context blocks from the preview text", () => {
    const rows: MessagesTimelineRow[] = [
      {
        kind: "message",
        id: "entry-user-1",
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user",
          text: "Look at the log\n\n<terminal_context>\n- session 1:\nhello\nworld\n</terminal_context>",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
        durationStart: "2026-01-01T00:00:00Z",
        showCompletionDivider: false,
        showAssistantCopyButton: false,
      },
    ];

    const entries = selectUserMessageMinimapEntries(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.previewText).toBe("Look at the log");
  });

  it("falls back to a placeholder when the visible text is empty but a terminal context exists", () => {
    const rows: MessagesTimelineRow[] = [
      {
        kind: "message",
        id: "entry-user-1",
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user",
          text: "<terminal_context>\n- session 1:\nhello\n</terminal_context>",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
        durationStart: "2026-01-01T00:00:00Z",
        showCompletionDivider: false,
        showAssistantCopyButton: false,
      },
    ];

    const entries = selectUserMessageMinimapEntries(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.previewText).toBe("(terminal context)");
  });
});

describe("computeActiveMinimapIndex", () => {
  const makeEntry = (i: number, rowKey: string): MinimapUserMessageEntry => ({
    rowIndex: i * 2,
    rowKey,
    messageId: `user-${i}` as MessageId,
    previewText: `msg ${i}`,
  });

  const makeState = ({
    scroll,
    scrollLength = 500,
    isAtEnd = false,
    positionsByKey = {},
    positionsByIndex = {},
  }: {
    scroll: number;
    scrollLength?: number;
    isAtEnd?: boolean;
    positionsByKey?: Record<string, number>;
    positionsByIndex?: Record<number, number>;
  }): MinimapListStateSnapshot => ({
    scroll,
    scrollLength,
    isAtEnd,
    positionByKey: (key) => positionsByKey[key],
    positionAtIndex: (index) => positionsByIndex[index],
  });

  it("returns undefined when there are no entries so the caller leaves state alone", () => {
    expect(computeActiveMinimapIndex(makeState({ scroll: 0 }), [])).toBeUndefined();
  });

  it("returns undefined before the list has been measured (scrollLength is 0)", () => {
    const a = makeEntry(1, "a");
    const state = makeState({
      scroll: 0,
      scrollLength: 0,
      positionsByKey: { a: 100 },
    });
    expect(computeActiveMinimapIndex(state, [a])).toBeUndefined();
  });

  it("returns undefined until at least one entry position has been measured", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const state = makeState({ scroll: 1000 });
    expect(computeActiveMinimapIndex(state, [a, b])).toBeUndefined();
  });

  it("keeps the first entry active while the user is at the very top of the thread", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const state = makeState({ scroll: 0, positionsByKey: { a: 100, b: 900 } });
    expect(computeActiveMinimapIndex(state, [a, b])).toBe(0);
  });

  it("keeps the first entry active while the next entry's top is still below the viewport top", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const state = makeState({ scroll: 500, positionsByKey: { a: 100, b: 900 } });
    expect(computeActiveMinimapIndex(state, [a, b])).toBe(0);
  });

  it("activates the next entry once its top has scrolled at/above the viewport top", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 1000,
      positionsByKey: { a: 100, b: 900, c: 1700 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(1);
  });

  it("activates the last entry when its top finally reaches the viewport top", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    // scroll=1700 → threshold=1708. All three satisfy → c active.
    const state = makeState({
      scroll: 1700,
      positionsByKey: { a: 100, b: 900, c: 1700 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(2);
  });

  it("does not activate the last entry when max scroll can't push its top above the viewport top", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 1500,
      scrollLength: 500,
      positionsByKey: { a: 100, b: 900, c: 1700 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(1);
  });

  it("advances past a prompt whose body has scrolled off when the next prompt enters from below", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 200,
      positionsByKey: { a: 100, b: 500, c: 1200 },
      positionsByIndex: { 3: 150, 5: 550 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(1);
  });

  it("does not advance past a prompt while any part of it is still visible", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const state = makeState({
      scroll: 100,
      positionsByKey: { a: 100, b: 500 },
      positionsByIndex: { 3: 150 },
    });
    expect(computeActiveMinimapIndex(state, [a, b])).toBe(0);
  });

  it("does not advance when the next prompt hasn't entered the viewport yet", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 600,
      positionsByKey: { a: 100, b: 500, c: 1200 },
      positionsByIndex: { 3: 150, 5: 550 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(1);
  });

  it("stops at unmeasured gaps instead of skipping ahead to later measured entries", () => {
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 1300,
      positionsByKey: { a: 100, c: 1200 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(0);
  });

  it("activates the last entry when the list is scrolled to the end", () => {
    // Canonical case: a short final prompt (here: c at top=1200) sits at the
    // bottom of the viewport but its top never reaches the viewport top.
    // Without the at-end short-circuit, the viewport-top rule would keep an
    // earlier prompt active while the reader is plainly looking at the last.
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 900,
      scrollLength: 500,
      isAtEnd: true,
      positionsByKey: { a: 100, b: 500, c: 1200 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(2);
  });

  it("ignores isAtEnd=false and falls through to the viewport-top rule", () => {
    // Sanity-check: the at-end short-circuit doesn't fire while the reader
    // is mid-scroll. Same scroll position as the previous test, but `isAtEnd`
    // is false, so the normal walk picks the entry whose top is at/above the
    // viewport top + 8 buffer.
    const a = makeEntry(1, "a");
    const b = makeEntry(2, "b");
    const c = makeEntry(3, "c");
    const state = makeState({
      scroll: 900,
      scrollLength: 500,
      isAtEnd: false,
      positionsByKey: { a: 100, b: 500, c: 1200 },
    });
    expect(computeActiveMinimapIndex(state, [a, b, c])).toBe(1);
  });
});

describe("selectVisibleMinimapEntries", () => {
  const make = (count: number): MinimapUserMessageEntry[] =>
    Array.from({ length: count }, (_, i) => ({
      rowIndex: i * 2,
      rowKey: `entry-${i}`,
      messageId: `user-${i}` as MessageId,
      previewText: `msg ${i}`,
    }));

  it("returns the input untouched when there are no entries", () => {
    const result = selectVisibleMinimapEntries({
      entries: [],
      navHeight: 600,
      activeIndex: null,
    });
    expect(result.visibleEntries).toEqual([]);
    expect(result.visibleActiveIndex).toBeNull();
  });

  it("renders every entry before the strip has been measured to avoid a popping flash", () => {
    const entries = make(40);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: null,
      activeIndex: 3,
    });
    expect(result.visibleEntries).toBe(entries);
    expect(result.visibleActiveIndex).toBe(3);
  });

  it("renders all entries naturally when they fit under the cap", () => {
    // 8 ≤ MAX_VISIBLE_MINIMAP_DASHES (10) → no sampling, no overflow label.
    const entries = make(8);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 600,
      activeIndex: 3,
    });
    expect(result.visibleEntries).toBe(entries);
    expect(result.visibleActiveIndex).toBe(3);
    expect(result.hiddenCount).toBe(0);
  });

  it("samples down to MAX_VISIBLE_MINIMAP_DASHES when entries exceed the cap", () => {
    // navHeight=700 fits ~98 dashes pixel-wise but the hard 10-dash cap wins.
    const entries = make(200);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 700,
      activeIndex: 0,
    });
    expect(result.visibleEntries.length).toBe(10);
    // First and last source entries stay pinned even after the cap kicks in.
    expect(result.visibleEntries[0]).toBe(entries[0]);
    expect(result.visibleEntries[result.visibleEntries.length - 1]).toBe(entries[199]);
  });

  it("places the active highlight at the visible slot closest to the source active index", () => {
    // capacity = min(MAX_VISIBLE_MINIMAP_DASHES, pixelCapacity) = 10.
    // Projection: round(sourceActive * (capacity - 1) / (entries.length - 1))
    //   = round(sourceActive * 9 / 199).
    const entries = make(200);
    const middleResult = selectVisibleMinimapEntries({
      entries,
      navHeight: 700,
      activeIndex: 100,
    });
    // round(100 * 9 / 199) = round(4.522…) = 5
    expect(middleResult.visibleActiveIndex).toBe(5);

    const firstResult = selectVisibleMinimapEntries({
      entries,
      navHeight: 700,
      activeIndex: 0,
    });
    expect(firstResult.visibleActiveIndex).toBe(0);

    const lastResult = selectVisibleMinimapEntries({
      entries,
      navHeight: 700,
      activeIndex: 199,
    });
    // round(199 * 9 / 199) = 9 (last slot)
    expect(lastResult.visibleActiveIndex).toBe(9);
  });

  it("collapses to a single dash when the strip can only fit one row", () => {
    const entries = make(20);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 12,
      activeIndex: 8,
    });
    expect(result.visibleEntries).toEqual([entries[8]]);
    expect(result.visibleActiveIndex).toBe(0);
  });

  it("falls back to the first entry when capacity is one and nothing is active", () => {
    const entries = make(20);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 12,
      activeIndex: null,
    });
    expect(result.visibleEntries).toEqual([entries[0]]);
    expect(result.visibleActiveIndex).toBe(0);
  });

  it("clamps stale active index when capacity is one", () => {
    const entries = make(20);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 12,
      activeIndex: 250,
    });
    expect(result.visibleEntries).toEqual([entries[19]]);
    expect(result.visibleActiveIndex).toBe(0);
  });

  it("clamps an out-of-range active index into the visible window", () => {
    const entries = make(200);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 700,
      activeIndex: 250,
    });
    // activeIndex 250 clamps to 199 (last entry); projected slot is the last.
    expect(result.visibleActiveIndex).toBe(9);
  });

  it("caps visible entries at MAX_VISIBLE_MINIMAP_DASHES even when navHeight could fit more", () => {
    // navHeight=2000 has pixel capacity for ~284 dashes, but the hard cap is 10.
    const entries = make(50);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 2000,
      activeIndex: null,
    });
    expect(result.visibleEntries.length).toBe(10);
  });

  it("reports hiddenCount = 0 when every entry fits within the cap", () => {
    const result = selectVisibleMinimapEntries({
      entries: make(7),
      navHeight: 600,
      activeIndex: null,
    });
    expect(result.hiddenCount).toBe(0);
  });

  it("reports hiddenCount = entries.length - visibleEntries.length when sampling", () => {
    // 50 entries sampled to 10 → 40 hidden, surfaced as the "+40" label.
    const entries = make(50);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 600,
      activeIndex: null,
    });
    expect(result.visibleEntries.length).toBe(10);
    expect(result.hiddenCount).toBe(40);
  });

  it("pins the first and last entries after the cap kicks in", () => {
    // The whole-thread "scrollbar" affordance relies on first and last always
    // being represented — the user should never lose sight of either end.
    const entries = make(50);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 600,
      activeIndex: null,
    });
    expect(result.visibleEntries[0]).toBe(entries[0]);
    expect(result.visibleEntries[result.visibleEntries.length - 1]).toBe(entries[49]);
  });

  it("reports hiddenCount on the single-slot fallback so the label still appears", () => {
    // navHeight=12 → pixel capacity 1, so the cap doesn't change anything,
    // but the result still needs a non-zero hiddenCount because 19 of 20
    // entries are absent from the strip.
    const entries = make(20);
    const result = selectVisibleMinimapEntries({
      entries,
      navHeight: 12,
      activeIndex: 4,
    });
    expect(result.visibleEntries).toEqual([entries[4]]);
    expect(result.hiddenCount).toBe(19);
  });

  it("reports hiddenCount = 0 before measurement and on empty input", () => {
    expect(
      selectVisibleMinimapEntries({ entries: [], navHeight: 600, activeIndex: null }).hiddenCount,
    ).toBe(0);
    expect(
      selectVisibleMinimapEntries({ entries: make(50), navHeight: null, activeIndex: 0 })
        .hiddenCount,
    ).toBe(0);
  });
});
