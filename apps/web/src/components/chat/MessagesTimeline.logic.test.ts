import { describe, expect, it } from "vite-plus/test";
import {
  buildToolCallExpandedBody,
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  describeToolCallWorkEntry,
  hasToolCallExpandedBody,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  workEntryIconName,
} from "./MessagesTimeline.logic";
import { type WorkLogEntry } from "../../session-logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
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

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
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
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
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
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
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
            updatedAt: "2026-01-01T00:00:00Z",
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
            updatedAt: "2026-01-01T00:00:11Z",
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
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
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
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
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
            updatedAt: "2026-01-01T00:00:00Z",
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
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
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

  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            turnId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        turnId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestTurn still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "assistant-thought-entry",
      "work-entry-1",
      "working-indicator-row",
    ]);
  });

  it("does not fold the session's running turn when latestTurn regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            turnId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.turnId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("running-work-entry");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
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
            text: "Done.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });

  it("models work log overflow expansion as inserted list rows", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "edit",
          detail: "Editing MessagesTimeline.tsx",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-3", "work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 2,
      expanded: false,
      onlyToolEntries: true,
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-1",
      "work-2",
      "work-3",
      "work-toggle:work-entry-1",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
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
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
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

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
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

describe("describeToolCallWorkEntry", () => {
  const WORKSPACE_ROOT = "/Users/dev/t3code";

  function makeWorkEntry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
    return {
      id: "work-1",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Tool call",
      tone: "tool",
      ...overrides,
    };
  }

  it("names Claude read calls after the file they read", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "Tool call",
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"/Users/dev/t3code/apps/web/src/app.ts"}',
        toolName: "Read",
        toolInput: { file_path: "/Users/dev/t3code/apps/web/src/app.ts" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({
      heading: "Read file",
      preview: "t3code/apps/web/src/app.ts",
    });
  });

  it("prefers the structured command over the prefixed detail Claude echoes", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Command run",
        toolTitle: "Command run",
        itemType: "command_execution",
        detail: "Bash: git status",
        command: "Bash: git status",
        toolName: "Bash",
        toolInput: { command: "git status", description: "Check the working tree" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Ran command", preview: "git status" });
  });

  it("previews grep calls with their pattern", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "Tool call",
        itemType: "dynamic_tool_call",
        toolName: "Grep",
        toolInput: { pattern: "useEffect\\(", path: "/Users/dev/t3code/apps/web" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Searched code", preview: "useEffect\\(" });
  });

  it("previews web search calls with their query", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "Web search",
        itemType: "web_search",
        toolName: "WebSearch",
        toolInput: { query: "react useEffect cleanup" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Searched the web", preview: "react useEffect cleanup" });
  });

  it("previews web fetch calls with their url", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "Tool call",
        itemType: "dynamic_tool_call",
        toolName: "WebFetch",
        toolInput: { url: "https://example.com/docs", prompt: "Summarize the page" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Fetched page", preview: "https://example.com/docs" });
  });

  it("keeps MCP identity when the adapter misclassified the item type", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "File change",
        toolTitle: "File change",
        itemType: "file_change",
        toolName: "create_pr",
        toolServer: "github",
        toolInput: { title: "Fix login bug", body: "Resets the session on 401" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "github · create_pr", preview: "Fix login bug" });
  });

  it("falls back to the row detail for MCP calls without arguments", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "t3-code · preview_status",
        toolTitle: "t3-code · preview_status",
        itemType: "mcp_tool_call",
        detail: "19 files",
        toolName: "preview_status",
        toolServer: "t3-code",
        toolInput: {},
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "t3-code · preview_status", preview: "19 files" });
  });

  it("recovers the tool from legacy '<Tool>: <json>' details", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Tool call completed",
        toolTitle: "Tool call",
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"/tmp/app.ts"}',
        command: "sed -n 1,40p /tmp/app.ts",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Read file", preview: "/tmp/app.ts" });
  });

  it("recovers the command from a legacy shell-prefixed detail", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Command run",
        toolTitle: "Command run",
        itemType: "command_execution",
        detail: "Bash: git status",
        command: "Bash: git status",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Ran command", preview: "git status" });
  });

  it("humanizes unknown dynamic tool names", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "Tool call",
        itemType: "dynamic_tool_call",
        toolName: "preview_status",
        toolInput: { target: "web" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Preview status", preview: "web" });
  });

  it("prefers the changed-files summary for edits", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "File change",
        toolTitle: "File change",
        itemType: "file_change",
        toolName: "Edit",
        toolInput: { file_path: "/Users/dev/t3code/apps/web/src/a.ts" },
        changedFiles: [
          "/Users/dev/t3code/apps/web/src/a.ts",
          "/Users/dev/t3code/apps/web/src/b.ts",
        ],
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({
      heading: "Edited file",
      preview: "t3code/apps/web/src/a.ts +1 more",
    });
  });

  it("describes subagent calls with their description", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Subagent task",
        toolTitle: "Subagent task",
        itemType: "collab_agent_tool_call",
        detail: "Explore the auth module",
        toolName: "Task",
        toolInput: {
          description: "Explore the auth module",
          prompt: "Read every file under apps/server/src/auth and report the entry points.",
          subagent_type: "explore",
        },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Ran subagent", preview: "Explore the auth module" });
  });

  it("drops the preview for to-do updates", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "Tool call",
        itemType: "dynamic_tool_call",
        toolName: "TodoWrite",
        toolInput: { todos: [{ content: "Ship it" }] },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Updated to-do list", preview: null });
  });

  it("truncates long previews", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolName: "Bash",
        toolInput: { command: `echo ${"x".repeat(200)}` },
      }),
      WORKSPACE_ROOT,
    );

    expect(display.preview).toHaveLength(120);
    expect(display.preview?.endsWith("…")).toBe(true);
  });

  it("leaves prose details alone", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Ran command",
        toolTitle: "Ran command",
        itemType: "command_execution",
        command: "grep -R nope .",
        detail: "grep: command not found",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Ran command", preview: "grep -R nope ." });
  });

  it("reproduces the legacy heading and preview when nothing identifies the tool", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Glob",
        detail: "No files found",
        toolLifecycleStatus: "failed",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Glob", preview: "No files found" });
  });

  it("falls back to the changed-files summary when there is no detail", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Changed files",
        toolTitle: "Changed files",
        itemType: "file_change",
        changedFiles: ["/Users/dev/t3code/a.ts", "/Users/dev/t3code/b.ts"],
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Changed files", preview: "t3code/a.ts +1 more" });
  });
});

describe("describeToolCallWorkEntry legacy shell prefixes", () => {
  it("does not read a shell error in the output as the command that ran", () => {
    const display = describeToolCallWorkEntry(
      {
        id: "work-1",
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Ran command",
        tone: "tool",
        toolTitle: "Ran command",
        itemType: "command_execution",
        command: "foo --bar",
        detail: "bash: foo: command not found",
      },
      "/Users/dev/t3code",
    );

    expect(display).toEqual({ heading: "Ran command", preview: "foo --bar" });
  });
});

describe("describeToolCallWorkEntry does not invent tool calls", () => {
  const WORKSPACE_ROOT = "/Users/dev/t3code";

  function makeWorkEntry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
    return {
      id: "work-1",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Tool call",
      tone: "tool",
      ...overrides,
    };
  }

  it("keeps error prose that merely opens with a shell word", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Provider error",
        tone: "error",
        detail: "sh: permission denied while starting the agent",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({
      heading: "Provider error",
      preview: "sh: permission denied while starting the agent",
    });
  });

  it("keeps reasoning prose that opens with a command word", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Thinking",
        tone: "thinking",
        detail: "Command: run the migration",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Thinking", preview: "Command: run the migration" });
  });

  it("keeps a shell-prefixed label as the row heading", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({ label: "Shell: exited with code 1", tone: "error" }),
      WORKSPACE_ROOT,
    );

    expect(display.heading).toBe("Shell: exited with code 1");
  });

  it("keeps prose that quotes JSON instead of turning the word into a tool", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({ detail: 'Result: {"ok":true}' }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Tool call", preview: 'Result: {"ok":true}' });
  });

  it("still recovers an MCP call from a legacy prefixed detail", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({ detail: 'mcp__github__create_pr: {"title":"Fix login bug"}' }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "github · create_pr", preview: "Fix login bug" });
  });

  it("phrases a pending command approval as the request, not as a finished call", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "Command approval requested",
        tone: "info",
        requestKind: "command",
        detail: "Bash: rm -rf /tmp/build",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({
      heading: "Command approval requested",
      preview: "Bash: rm -rf /tmp/build",
    });
  });

  it("phrases a pending file approval as the request, not as a finished read", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        label: "File read approval requested",
        tone: "info",
        requestKind: "file-read",
        detail: 'Read: {"file_path":"/etc/passwd"}',
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({
      heading: "File read approval requested",
      preview: 'Read: {"file_path":"/etc/passwd"}',
    });
  });
});

describe("describeToolCallWorkEntry argument handling", () => {
  const WORKSPACE_ROOT = "/Users/dev/t3code";

  function makeWorkEntry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
    return {
      id: "work-1",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Tool call",
      tone: "tool",
      ...overrides,
    };
  }

  it("names OpenCode reads after their camelCase filePath instead of the output", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "read",
        itemType: "dynamic_tool_call",
        toolName: "read",
        toolInput: { filePath: "/Users/dev/t3code/apps/web/src/a.ts" },
        detail: "<file>\n00001| import x from 'y';\n</file>",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Read file", preview: "t3code/apps/web/src/a.ts" });
  });

  it("names OpenCode edits after their camelCase filePath instead of the diff", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolTitle: "edit",
        itemType: "file_change",
        toolName: "edit",
        toolInput: { filePath: "/Users/dev/t3code/apps/web/src/a.ts" },
        detail: "diff --git a/x b/x\n+added",
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Edited file", preview: "t3code/apps/web/src/a.ts" });
  });

  it("normalizes argv-array commands the way the row command is normalized", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({ toolName: "Bash", toolInput: { command: ["bash", "-lc", "git status"] } }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "Ran command", preview: "git status" });
  });

  it("leaves MCP arguments unrewritten — they address the server, not the checkout", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({
        toolName: "get_file_contents",
        toolServer: "github",
        toolInput: { owner: "o", repo: "r", path: "src/index.ts" },
      }),
      WORKSPACE_ROOT,
    );

    expect(display).toEqual({ heading: "github · get_file_contents", preview: "src/index.ts" });
  });

  it("does not turn slash-bearing arguments into workspace files", () => {
    for (const [input, expected] of [
      [{ repository: "t3-tools/t3code" }, "t3-tools/t3code"],
      [{ branch: "feature/login-fix" }, "feature/login-fix"],
      [{ ref: "refs/heads/main" }, "refs/heads/main"],
      [{ module: "@scope/pkg" }, "@scope/pkg"],
    ] as const) {
      const display = describeToolCallWorkEntry(
        makeWorkEntry({ toolName: "list_commits", toolInput: input }),
        WORKSPACE_ROOT,
      );

      expect(display.preview).toBe(expected);
    }
  });

  it("does not rewrite a URL passed under a path-shaped argument", () => {
    for (const entry of [
      makeWorkEntry({
        toolName: "open",
        toolServer: "browser",
        toolInput: { path: "https://example.com/docs/page" },
      }),
      makeWorkEntry({
        toolName: "open_page",
        toolInput: { path: "https://example.com/docs/page" },
      }),
    ]) {
      expect(describeToolCallWorkEntry(entry, WORKSPACE_ROOT).preview).toBe(
        "https://example.com/docs/page",
      );
    }
  });

  it("still resolves real relative file paths against the workspace", () => {
    const display = describeToolCallWorkEntry(
      makeWorkEntry({ toolName: "Read", toolInput: { file_path: "apps/web/src/a.ts" } }),
      WORKSPACE_ROOT,
    );

    expect(display.preview).toBe("t3code/apps/web/src/a.ts");
  });
});

describe("work entry row chrome", () => {
  const WORKSPACE_ROOT = "/Users/dev/t3code";

  function makeWorkEntry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
    return {
      id: "work-1",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Tool call",
      tone: "tool",
      ...overrides,
    };
  }

  it("marks MCP rows with the wrench even when the adapter misclassified them", () => {
    expect(
      workEntryIconName(
        makeWorkEntry({
          itemType: "file_change",
          toolName: "create_pr",
          toolServer: "github",
          changedFiles: ["/Users/dev/t3code/a.ts"],
        }),
      ),
    ).toBe("wrench");
  });

  it("keeps the pre-existing icon precedence for non-MCP rows", () => {
    expect(workEntryIconName(makeWorkEntry({ requestKind: "command" }))).toBe("terminal");
    expect(workEntryIconName(makeWorkEntry({ itemType: "command_execution" }))).toBe("terminal");
    expect(workEntryIconName(makeWorkEntry({ itemType: "file_change" }))).toBe("square-pen");
    expect(workEntryIconName(makeWorkEntry({ itemType: "web_search" }))).toBe("globe");
    expect(workEntryIconName(makeWorkEntry({ itemType: "mcp_tool_call" }))).toBe("wrench");
    expect(workEntryIconName(makeWorkEntry({ itemType: "dynamic_tool_call" }))).toBe("hammer");
    expect(workEntryIconName(makeWorkEntry({ tone: "error" }))).toBe("circle-alert");
    expect(workEntryIconName(makeWorkEntry({ tone: "tool" }))).toBe("zap");
  });

  it("agrees with the expanded body it guards", () => {
    const entries: WorkLogEntry[] = [
      makeWorkEntry({}),
      makeWorkEntry({ detail: "   " }),
      makeWorkEntry({ detail: "19 files" }),
      makeWorkEntry({ command: "git status" }),
      makeWorkEntry({ command: "git status", rawCommand: 'pwsh -Command "git status"' }),
      makeWorkEntry({ rawCommand: 'pwsh -Command "git status"' }),
      makeWorkEntry({ changedFiles: ["/Users/dev/t3code/a.ts"] }),
      makeWorkEntry({ toolInput: {} }),
      makeWorkEntry({ toolInput: { pattern: "useEffect" } }),
      makeWorkEntry({ itemType: "mcp_tool_call", toolData: { server: "t3-code" } }),
    ];

    for (const entry of entries) {
      expect(hasToolCallExpandedBody(entry)).toBe(
        buildToolCallExpandedBody(entry, WORKSPACE_ROOT) !== null,
      );
    }
  });

  it("appends the tool input for non-MCP rows", () => {
    const body = buildToolCallExpandedBody(
      makeWorkEntry({ toolName: "Grep", toolInput: { pattern: "useEffect" } }),
      WORKSPACE_ROOT,
    );

    expect(body).toBe('Input\n{\n  "pattern": "useEffect"\n}');
  });

  it("leaves the input out of MCP rows, which already show the whole call", () => {
    const body = buildToolCallExpandedBody(
      makeWorkEntry({
        itemType: "mcp_tool_call",
        toolData: { tool: "preview_status" },
        toolInput: { interactiveOnly: true },
      }),
      WORKSPACE_ROOT,
    );

    expect(body).toContain("MCP call");
    expect(body).not.toContain("Input");
  });

  it("bounds a tool input that carries a whole file", () => {
    const content = "const x = 1;\n".repeat(2000);
    const body = buildToolCallExpandedBody(
      makeWorkEntry({
        toolName: "Write",
        toolInput: { file_path: "/Users/dev/t3code/a.ts", content },
      }),
      WORKSPACE_ROOT,
    );

    expect(body).toContain("/Users/dev/t3code/a.ts");
    expect(body).toContain(`(+${content.length - 400} more characters)`);
    expect(body!.length).toBeLessThan(1000);
  });

  it("bounds a tool input dictionary with many keys", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`file-${index}.ts`, `sha-${index}`]),
    );
    const body = buildToolCallExpandedBody(
      makeWorkEntry({ toolName: "Catalog", toolInput: metadata }),
      WORKSPACE_ROOT,
    );

    expect(body).toContain("file-19.ts");
    expect(body).not.toContain("file-20.ts");
    expect(body).toContain("(+480 more entries)");
    expect(body!.length).toBeLessThan(1500);
  });

  it("bounds long arrays and deep nesting in tool input", () => {
    const body = buildToolCallExpandedBody(
      makeWorkEntry({
        toolName: "MultiEdit",
        toolInput: { edits: Array.from({ length: 50 }, (_, index) => ({ old: `line ${index}` })) },
      }),
      WORKSPACE_ROOT,
    );

    expect(body).toContain("(+30 more items)");
  });
});
