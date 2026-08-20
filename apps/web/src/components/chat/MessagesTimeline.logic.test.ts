import { describe, expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  summarizeToolGroup,
  shouldPreserveAssistantLineBreaks,
} from "./MessagesTimeline.logic";

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

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

describe("summarizeToolGroup", () => {
  it("distinguishes local grep from web search", () => {
    expect(
      summarizeToolGroup([
        {
          id: "grep",
          createdAt: "2026-01-01T00:00:00Z",
          label: "grep",
          toolTitle: "grep",
          tone: "tool",
          itemType: "web_search",
        },
      ]),
    ).toBe("Searched code 1 time");
    expect(
      summarizeToolGroup([
        {
          id: "web-search",
          createdAt: "2026-01-01T00:00:00Z",
          label: "Web search",
          toolTitle: "Web search",
          tone: "tool",
          itemType: "web_search",
        },
      ]),
    ).toBe("Searched the web 1 time");
  });

  it("recognizes provider-neutral read tool calls", () => {
    expect(
      summarizeToolGroup([
        {
          id: "read-file",
          createdAt: "2026-01-01T00:00:00Z",
          label: "Read File",
          toolTitle: "Read File",
          tone: "tool",
          itemType: "dynamic_tool_call",
        },
      ]),
    ).toBe("Read 1 file");
  });

  it("counts id-less lifecycle markers as one completed tool", () => {
    expect(
      summarizeToolGroup([
        {
          id: "legacy-update",
          createdAt: "2026-01-01T00:00:00Z",
          label: "Glob",
          tone: "tool",
          itemType: "mcp_tool_call",
          sourceActivityKind: "tool.updated",
        },
        {
          id: "legacy-complete",
          createdAt: "2026-01-01T00:00:01Z",
          label: "Glob",
          tone: "tool",
          itemType: "mcp_tool_call",
          sourceActivityKind: "tool.completed",
          toolLifecycleStatus: "completed",
        },
      ]),
    ).toBe("Used 1 tool");
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
      "work-toggle:work-entry-1",
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

  it("keeps a collapsed superseded turn fold by the response and expands it downward", () => {
    const timelineEntries = [
      {
        id: "initial-user-entry",
        kind: "message",
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "initial-user" as never,
          role: "user",
          text: "Start the work",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work",
        createdAt: "2026-01-01T00:00:10Z",
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:10Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool",
        },
      },
      {
        id: "steer-user-entry",
        kind: "message",
        createdAt: "2026-01-01T00:00:12Z",
        message: {
          id: "steer-user" as never,
          role: "user",
          text: "Change the approach",
          turnId: null,
          createdAt: "2026-01-01T00:00:12Z",
          updatedAt: "2026-01-01T00:00:12Z",
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
          text: "Implemented locally, uncommitted.",
          turnId: "turn-2" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:21Z",
          streaming: false,
        },
      },
    ] satisfies Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"];
    const input = {
      timelineEntries,
      latestTurn: {
        turnId: "turn-2" as never,
        state: "completed" as const,
        startedAt: "2026-01-01T00:00:12Z",
        completedAt: "2026-01-01T00:00:21Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const rows = deriveMessagesTimelineRows(input);

    expect(rows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      "steer-user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      ...input,
      expandedTurnIds: new Set(["turn-1" as never]),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      "turn-fold:turn-1",
      "work-toggle:superseded-work-entry",
      "steer-user-entry",
      "assistant-final-entry",
    ]);
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

  it("does not claim an unkeyed plan for the active turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user" as never,
            role: "user",
            text: "Make a plan",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "plan-entry",
          kind: "proposed-plan",
          createdAt: "2026-01-01T00:00:01Z",
          proposedPlan: {
            id: "plan" as never,
            turnId: null,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:02Z",
          message: {
            id: "assistant" as never,
            role: "assistant",
            text: "Planning now.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:02Z",
            updatedAt: "2026-01-01T00:00:02Z",
            streaming: true,
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

    expect(rows.map((row) => row.id)).toEqual([
      "user-entry",
      "plan-entry",
      "working-indicator-row",
      "assistant-entry",
    ]);
  });

  it("does not treat an older turn's proposed plan as active content", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user" as never,
            role: "user",
            text: "Continue",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "older-plan-entry",
          kind: "proposed-plan",
          createdAt: "2026-01-01T00:00:01Z",
          proposedPlan: {
            id: "older-plan" as never,
            turnId: "turn-old" as never,
            planMarkdown: "# Old plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
          },
        },
      ],
      latestTurn: {
        turnId: "turn-current" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.find((row) => row.kind === "working")).toMatchObject({ showThinking: true });
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
            toolLifecycleStatus: "inProgress" as const,
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
      "working-indicator-row",
      "assistant-thought-entry",
      "work-live:work-entry-1",
    ]);
  });

  it("keeps the current tool batch expandable while live entries append", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          turnId: "turn-1" as never,
          toolCallId: "call-1",
          label: "Read file",
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
          turnId: "turn-1" as never,
          toolCallId: "call-2",
          label: "Run command",
          command: "vp test run",
          tone: "tool" as const,
        },
      },
    ];
    const baseInput = {
      timelineEntries,
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };

    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:tool:turn-1:call-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "work-live:tool:turn-1:call-1",
    ]);
    expect(collapsedRows.find((row) => row.kind === "work-live")).toMatchObject({
      groupId: "work-group:tool:turn-1:call-1",
      expanded: false,
      groupedEntries: [{ id: "work-1" }, { id: "work-2" }],
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "work-live:tool:turn-1:call-1",
      "work-1",
      "work-2",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-live")).toMatchObject({
      groupId: "work-group:tool:turn-1:call-1",
      expanded: true,
    });

    const appendedRows = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        ...timelineEntries,
        {
          id: "work-entry-3",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "work-3",
            createdAt: "2026-01-01T00:00:03Z",
            turnId: "turn-1" as never,
            toolCallId: "call-3",
            label: "Changed file",
            tone: "tool" as const,
          },
        },
      ],
      expandedWorkGroupIds: new Set(["work-group:tool:turn-1:call-1"]),
    });

    expect(appendedRows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "work-live:tool:turn-1:call-1",
      "work-1",
      "work-2",
      "work-3",
    ]);
    expect(appendedRows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "work-3" },
      groupedEntries: [{ id: "work-1" }, { id: "work-2" }, { id: "work-3" }],
    });

    const rowsAfterFirstToolSettles = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        {
          ...timelineEntries[0]!,
          entry: {
            ...timelineEntries[0]!.entry,
            toolLifecycleStatus: "stopped" as const,
          },
        },
        {
          ...timelineEntries[1]!,
          entry: {
            ...timelineEntries[1]!.entry,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      expandedWorkGroupIds: new Set(["work-group:tool:turn-1:call-1"]),
    });

    expect(rowsAfterFirstToolSettles.find((row) => row.kind === "work-live")).toMatchObject({
      id: "work-live:tool:turn-1:call-1",
      groupId: "work-group:tool:turn-1:call-1",
      expanded: true,
      entry: { id: "work-2" },
    });

    const rowsWithLaterPlan = deriveMessagesTimelineRows({
      ...baseInput,
      timelineEntries: [
        timelineEntries[0]!,
        {
          id: "commentary-entry",
          kind: "message" as const,
          createdAt: "2026-01-01T00:00:01.500Z",
          message: {
            id: "commentary-message" as never,
            role: "assistant" as const,
            text: "I found the relevant file.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01.500Z",
            updatedAt: "2026-01-01T00:00:01.500Z",
            streaming: false,
          },
        },
        timelineEntries[1]!,
        {
          id: "plan:thread-1:turn:turn-1",
          kind: "proposed-plan" as const,
          createdAt: "2026-01-01T00:00:03Z",
          proposedPlan: {
            id: "plan:thread-1:turn:turn-1",
            turnId: "turn-1" as never,
            planMarkdown: "# Next steps",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-01-01T00:00:03Z",
            updatedAt: "2026-01-01T00:00:03Z",
          },
        },
      ],
    });
    expect(rowsWithLaterPlan.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "commentary-entry",
      "work-live:tool:turn-1:call-1",
      "plan:thread-1:turn:turn-1",
    ]);
    expect(rowsWithLaterPlan.some((row) => row.kind === "work-toggle")).toBe(false);
  });

  it("omits superseded id-less lifecycle markers from a live batch", () => {
    const input = {
      timelineEntries: [
        {
          id: "legacy-update-entry",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "legacy-update",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            label: "Glob",
            tone: "tool" as const,
            itemType: "mcp_tool_call" as const,
            sourceActivityKind: "tool.updated" as const,
          },
        },
        {
          id: "legacy-complete-entry",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "legacy-complete",
            createdAt: "2026-01-01T00:00:02Z",
            turnId: "turn-1" as never,
            label: "Glob",
            tone: "tool" as const,
            itemType: "mcp_tool_call" as const,
            sourceActivityKind: "tool.completed" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };

    const collapsedRows = deriveMessagesTimelineRows(input);
    const expandedRows = deriveMessagesTimelineRows({
      ...input,
      expandedWorkGroupIds: new Set(["work-group:legacy-update-entry"]),
    });

    expect(collapsedRows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "legacy-complete" },
      groupedEntries: [{ id: "legacy-complete" }],
    });
    expect(expandedRows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "legacy-complete" },
      groupedEntries: [{ id: "legacy-complete" }],
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "work-live:legacy-update-entry",
      "legacy-complete",
    ]);
  });

  it("keeps parallel id-less markers when one matching live call completes", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "legacy-update-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "legacy-update",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            label: "Glob",
            tone: "tool" as const,
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.updated" as const,
          },
        },
        {
          id: "parallel-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "parallel-running",
            createdAt: "2026-01-01T00:00:02Z",
            turnId: "turn-1" as never,
            label: "Glob",
            tone: "tool" as const,
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.updated" as const,
          },
        },
        {
          id: "legacy-complete-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "legacy-complete",
            createdAt: "2026-01-01T00:00:03Z",
            turnId: "turn-1" as never,
            label: "Glob",
            tone: "tool" as const,
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.completed" as const,
            toolLifecycleStatus: "completed" as const,
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

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "legacy-complete" },
      groupedEntries: [
        { id: "legacy-update" },
        { id: "parallel-running" },
        { id: "legacy-complete" },
      ],
    });
  });

  it("advances the live label when a newer parallel call completes", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-running",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            toolCallId: "call-running",
            label: "Search files",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "work-completed-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-completed",
            createdAt: "2026-01-01T00:00:02Z",
            turnId: "turn-1" as never,
            toolCallId: "call-completed",
            label: "Read file",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
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

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "work-completed", toolLifecycleStatus: "completed" },
      groupedEntries: [{ id: "work-running" }, { id: "work-completed" }],
    });
  });

  it("keeps a completed trailing call in the live slot while the turn continues", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-completed-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-completed",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            toolCallId: "call-completed",
            label: "Ran tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
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

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "work-completed", toolLifecycleStatus: "completed" },
    });
    expect(rows.find((row) => row.kind === "working")).toMatchObject({ showThinking: false });
    expect(rows.some((row) => row.kind === "work-toggle")).toBe(false);
  });

  it("keeps one live tool line across commentary and a subagent row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "initial-tool-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "initial-tool",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            toolCallId: "call-initial",
            label: "Read file",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:02Z",
          message: {
            id: "commentary" as never,
            role: "assistant",
            text: "I found the relevant path.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:02Z",
            updatedAt: "2026-01-01T00:00:02Z",
            streaming: false,
          },
        },
        {
          id: "agent-spawn-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "agent-spawn",
            createdAt: "2026-01-01T00:00:03Z",
            turnId: "turn-1" as never,
            label: "Kicked off 2 subagents",
            tone: "thinking" as const,
            agentSpawn: { workflowId: null, agentTaskIds: ["task-1", "task-2"] },
          },
        },
        ...Array.from({ length: 19 }, (_, index) => ({
          id: `later-tool-entry-${index + 1}`,
          kind: "work" as const,
          createdAt: `2026-01-01T00:00:${String(index + 4).padStart(2, "0")}Z`,
          entry: {
            id: `later-tool-${index + 1}`,
            createdAt: `2026-01-01T00:00:${String(index + 4).padStart(2, "0")}Z`,
            turnId: "turn-1" as never,
            toolCallId: `call-${index + 1}`,
            label: `Tool ${index + 1}`,
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        })),
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

    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "commentary-entry",
      "agent-spawn-entry",
      "work-live:tool:turn-1:call-initial",
    ]);
    expect(rows.filter((row) => row.kind === "work-live")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "later-tool-19" },
    });
    expect(rows.some((row) => row.kind === "work-toggle")).toBe(false);
  });

  it("keeps thinking visible after an informational work entry", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "context-compacted-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "context-compacted",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            label: "Context compacted",
            tone: "info" as const,
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

    expect(rows.find((row) => row.kind === "working")).toMatchObject({ showThinking: true });
  });

  it("keeps task progress in the single live activity line", () => {
    const input = {
      timelineEntries: [
        {
          id: "task-progress-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "task-progress",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            taskId: "task-1",
            label: "Reviewing changes",
            tone: "thinking" as const,
            sourceActivityKind: "task.progress" as const,
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
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const rows = deriveMessagesTimelineRows(input);

    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "work-live:task-progress-entry",
    ]);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "task-progress" },
    });
    expect(rows.find((row) => row.kind === "working")).toMatchObject({ showThinking: false });

    const expandedRows = deriveMessagesTimelineRows({
      ...input,
      expandedWorkGroupIds: new Set(["work-group:task-progress-entry"]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "work-live:task-progress-entry",
      "task-progress",
    ]);
  });

  it("keeps the current tool batch live before an empty assistant placeholder", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            toolCallId: "call-1",
            label: "Run command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-placeholder-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:02Z",
          message: {
            id: "assistant-placeholder" as never,
            role: "assistant",
            text: "   ",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:02Z",
            updatedAt: "2026-01-01T00:00:02Z",
            streaming: true,
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

    expect(rows.map((row) => row.id)).toContain("work-live:tool:turn-1:call-1");
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
    expect(rows.map((row) => row.id)).toContain("work-live:running-work-entry");
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

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 3,
      expanded: false,
      onlyToolEntries: true,
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-toggle:work-entry-1",
      "work-1",
      "work-2",
      "work-3",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });

  it("filters only matching settled lifecycle markers", () => {
    const input = {
      timelineEntries: [
        {
          id: "unrelated-update-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "unrelated-update",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Read file",
            tone: "tool",
            itemType: "dynamic_tool_call",
            sourceActivityKind: "tool.updated",
          },
        },
        {
          id: "legacy-update-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "legacy-update",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Glob",
            tone: "tool",
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.updated",
          },
        },
        {
          id: "legacy-complete-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "legacy-complete",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Glob",
            tone: "tool",
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.completed",
            toolLifecycleStatus: "completed",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];

    const collapsedRows = deriveMessagesTimelineRows(input);
    const expandedRows = deriveMessagesTimelineRows({
      ...input,
      expandedWorkGroupIds: new Set(["work-group:unrelated-update-entry"]),
    });

    expect(collapsedRows).toHaveLength(1);
    expect(collapsedRows[0]).toMatchObject({
      kind: "work-toggle",
      hiddenCount: 2,
      hasFailure: false,
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-toggle:unrelated-update-entry",
      "unrelated-update",
      "legacy-complete",
    ]);
  });

  it("removes superseded lifecycle markers from mixed groups", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "legacy-update-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "legacy-update",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Glob",
            tone: "tool",
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.updated",
          },
        },
        {
          id: "legacy-complete-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "legacy-complete",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Glob",
            tone: "tool",
            itemType: "mcp_tool_call",
            sourceActivityKind: "tool.completed",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "spawn-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "spawn",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Kicked off an agent",
            tone: "thinking",
            agentSpawn: { workflowId: null, agentTaskIds: ["task-1"] },
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0]);

    expect(
      rows.flatMap((row) =>
        row.kind === "work" ? row.groupedEntries.map((entry) => entry.id) : [],
      ),
    ).toEqual(["legacy-complete", "spawn"]);
  });

  it("labels mixed-group overflow from the entries actually hidden", () => {
    const input = {
      timelineEntries: [
        {
          id: "tool-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "tool-1",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Read file",
            tone: "tool",
          },
        },
        {
          id: "spawn-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "spawn",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Kicked off an agent",
            tone: "thinking",
            agentSpawn: { workflowId: null, agentTaskIds: ["task-1"] },
          },
        },
        {
          id: "tool-entry-2",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "tool-2",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Run tests",
            tone: "tool",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    const rows = deriveMessagesTimelineRows(input);
    const expandedRows = deriveMessagesTimelineRows({
      ...input,
      expandedWorkGroupIds: new Set(["work-group:tool-entry-1"]),
    });

    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 1,
      onlyToolEntries: true,
    });
    expect(expandedRows.at(-1)).toMatchObject({
      kind: "work-toggle",
      expanded: true,
      onlyToolEntries: true,
      summary: null,
    });
  });

  it("keeps error entries visible instead of summarizing them as tools", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "runtime-error-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "runtime-error",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Provider disconnected",
            tone: "error",
            sourceActivityKind: "runtime.error",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "work", id: "runtime-error-entry" });
  });

  it("keeps an active error outside the live tool batch", () => {
    const turnId = "turn-active-error" as never;
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "runtime-error-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "runtime-error",
            createdAt: "2026-01-01T00:00:01Z",
            turnId,
            toolCallId: "failed-call",
            itemType: "command_execution",
            label: "Provider disconnected",
            tone: "error",
            sourceActivityKind: "runtime.error",
            toolLifecycleStatus: "failed",
          },
        },
        {
          id: "active-tool-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "active-tool",
            createdAt: "2026-01-01T00:00:02Z",
            turnId,
            toolCallId: "active-call",
            itemType: "command_execution",
            label: "Run tests",
            tone: "tool",
            toolLifecycleStatus: "inProgress",
          },
        },
      ],
      latestTurn: {
        turnId,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "runtime-error-entry",
      "work-live:tool:turn-active-error:active-call",
    ]);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      groupedEntries: [{ id: "active-tool" }],
    });
  });

  it("attributes overflow failure state only to hidden entries", () => {
    const deriveRowsForTones = (tones: ReadonlyArray<"error" | "info">) =>
      deriveMessagesTimelineRows({
        timelineEntries: tones.map((tone, index) => ({
          id: `work-entry-${index}`,
          kind: "work" as const,
          createdAt: `2026-01-01T00:00:0${index + 1}Z`,
          entry: {
            id: `work-${index}`,
            createdAt: `2026-01-01T00:00:0${index + 1}Z`,
            label: tone === "error" ? "Provider disconnected" : `Log ${index}`,
            tone,
            ...(tone === "error" ? { sourceActivityKind: "runtime.error" as const } : {}),
          },
        })),
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const hiddenFailureToggle = deriveRowsForTones(["error", "info", "info", "info"]).find(
      (row) => row.kind === "work-toggle",
    );
    const visibleFailureToggle = deriveRowsForTones(["info", "info", "info", "error"]).find(
      (row) => row.kind === "work-toggle",
    );

    expect(hiddenFailureToggle).toMatchObject({ hasFailure: true, hiddenCount: 3 });
    expect(visibleFailureToggle).toMatchObject({ hasFailure: false, hiddenCount: 3 });
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
