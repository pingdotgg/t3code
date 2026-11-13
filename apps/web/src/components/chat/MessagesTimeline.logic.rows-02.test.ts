import {
  MessageId,
  RunId,
  TurnItemId,
  deriveMessagesTimelineRows,
  deriveTimelineEntriesFromVisibleTurnItems,
  describe,
  expect,
  it,
  makeStreamingTimelineFixture,
  type OrchestrationV2ProjectedTurnItem,
  type TimelineEntry,
} from "./MessagesTimeline.logic-fixtures.ts";

describe("deriveMessagesTimelineRows", () => {
  it("shows a skipped compaction as stopped, without a separate interrupted divider", () => {
    const fixture = makeStreamingTimelineFixture();
    const [history0, history1, history2, liveUser, , liveAssistant] = fixture.visibleTurnItems;
    if (liveUser?.item.type !== "user_message" || liveAssistant?.item.type !== "assistant_message")
      throw new Error("Expected live fixture items");
    const prompt = {
      ...liveUser,
      item: { ...liveUser.item, text: "/compact", idleCompaction: "onReturn" as const },
    };
    const compaction = {
      ...liveAssistant,
      item: {
        ...liveAssistant.item,
        type: "compaction" as const,
        status: "interrupted" as const,
        driver: null,
      },
    };
    const interruptResult = {
      ...liveAssistant,
      item: {
        ...liveAssistant.item,
        id: TurnItemId.make("interrupt-result"),
        type: "run_interrupt_result" as const,
        status: "interrupted" as const,
        message: "Skipped compaction to send a queued message",
      },
    };
    const liveRowsFor = (visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [history0!, history1!, history2!, ...visibleTurnItems],
          optimisticMessages: [],
        }),
        isWorking: false,
        latestRun: {
          runId: fixture.runId,
          status: "interrupted",
          startedAt: fixture.time(5),
          completedAt: fixture.time(9),
        },
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      return rows.slice(rows.findIndex((row) => row.id.includes("history-assistant")) + 1);
    };

    expect(liveRowsFor([prompt, compaction, interruptResult])).toMatchObject([
      { kind: "context-compaction", label: "Context compaction stopped" },
    ]);
    // Stopped before the provider started: no compaction row says so, so the interrupt stays.
    expect(liveRowsFor([prompt, interruptResult]).map((row) => row.id)).toContain(
      "interrupt-result",
    );
  });

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
            runId: null,
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
            runId: "turn-1" as never,
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
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("projects assistant diffs and rewinds the first visible run to thread start after a rewind", () => {
    const assistantTurnDiffSummary = {
      runId: "turn-1" as never,
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
            runId: "turn-1" as never,
            inputIntent: "turn_start",
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
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [assistantTurnDiffSummary],
      supportsConversationRollback: true,
      threadStartCheckpointReady: true,
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(0);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds the first assistant message and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          runId: "turn-1" as never,
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
          runId: "turn-1" as never,
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
          runId: "turn-1" as never,
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
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it.each([1, 2, 3])("folds %i completed activities after the terminal response", (count) => {
    const runId = RunId.make("turn-1");
    const timelineEntries = [
      {
        id: "work-entry-before-text",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-before-text",
          createdAt: "2026-01-01T00:00:01Z",
          runId,
          label: "Status updated",
          tone: "info" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "CI is re-running. Waiting.",
          runId,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `work-entry-after-text-${index}`,
        kind: "work" as const,
        createdAt: `2026-01-01T00:00:0${index + 7}Z`,
        entry: {
          id: `work-after-text-${index}`,
          createdAt: `2026-01-01T00:00:0${index + 7}Z`,
          runId,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          toolLifecycleStatus: "completed" as const,
        },
      })),
    ];

    const input = {
      latestRun: {
        runId,
        status: "completed" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const rows = deriveMessagesTimelineRows({ ...input, timelineEntries });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
    const expanded = deriveMessagesTimelineRows({
      ...input,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(
      expanded.some(
        (row) =>
          row.id === "work-entry-after-text-0" ||
          (row.kind === "work-toggle" &&
            row.id === "work-toggle:work-entry-after-text-0" &&
            row.hiddenCount === count),
      ),
    ).toBe(true);

    const failedEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "failed" as const } }
        : entry,
    );
    const failedRows = deriveMessagesTimelineRows({ ...input, timelineEntries: failedEntries });
    expect(failedRows.some((row) => row.id === "work-entry-after-text-0")).toBe(true);

    const pendingEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "inProgress" as const } }
        : entry,
    );
    const pendingRows = deriveMessagesTimelineRows({
      ...input,
      timelineEntries: pendingEntries,
      latestRun: { ...input.latestRun, status: "running", completedAt: null },
      isWorking: true,
      activeTurnStartedAt: input.latestRun.startedAt,
    });
    expect(
      pendingRows.some((row) => row.kind === "work-live" && row.entry.id === "work-after-text-0"),
    ).toBe(true);
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
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
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-before-message",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "work-before-message",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Status updated",
            tone: "info" as const,
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
            runId: "turn-1" as never,
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
            runId: "turn-1" as never,
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
            runId: null,
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
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
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
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        runId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "keeps the duration header at the initiating prompt when %s arrives before output",
    (inputIntent) => {
      const runId = RunId.make("steered-run");
      const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
      const prompt = (id: string, second: number, intent: "turn_start" | typeof inputIntent) => ({
        kind: "message" as const,
        id,
        createdAt: time(second),
        message: {
          id: MessageId.make(id),
          role: "user" as const,
          text: id,
          runId,
          inputIntent: intent,
          createdAt: time(second),
          updatedAt: time(second),
          streaming: false,
        },
      });
      const entries = [prompt("initial-prompt", 0, "turn_start"), prompt("steer", 5, inputIntent)];
      const work = {
        kind: "work" as const,
        id: "work",
        createdAt: time(8),
        entry: {
          id: "work",
          createdAt: time(8),
          runId,
          label: "Ran command",
          tone: "tool" as const,
        },
      };
      const final = {
        kind: "message" as const,
        id: "final",
        createdAt: time(20),
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Done",
          runId,
          createdAt: time(20),
          updatedAt: time(20),
          streaming: false,
        },
      };
      for (const isWorking of [true, false]) {
        for (const expanded of [true, false]) {
          const rows = deriveMessagesTimelineRows({
            timelineEntries: [...entries, work, final],
            latestRun: {
              runId,
              status: isWorking ? "running" : "completed",
              startedAt: time(0),
              completedAt: isWorking ? null : time(20),
            },
            isWorking,
            activeTurnStartedAt: time(0),
            expandedRunIds: expanded ? new Set([runId]) : new Set(),
            turnDiffSummaries: [],
            supportsConversationRollback: false,
          });
          expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
            "initial-prompt",
            isWorking ? "working-indicator-row" : `turn-fold:${runId}`,
            "steer",
          ]);
          expect(rows[1]?.createdAt).toBe(time(0));
          if (!isWorking) expect(rows[1]).toMatchObject({ label: "Worked for 20s", expanded });
          expect(rows.some((row) => row.id === "final")).toBe(true);
          expect(rows.some((row) => row.id === "work")).toBe(isWorking || expanded);
        }
      }
    },
  );

  it("splits a settled turn's work at each steer and keeps the total time on top", () => {
    const runId = RunId.make("steered-run");
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const message = (
      id: string,
      second: number,
      role: "user" | "assistant",
      inputIntent?: "turn_start" | "steer",
    ): TimelineEntry => ({
      kind: "message",
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId,
        ...(inputIntent ? { inputIntent } : {}),
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const work = (id: string, second: number): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: time(second),
      entry: { id, createdAt: time(second), runId, label: "Ran command", tone: "tool" },
    });
    const rows = (expandedRunIds: ReadonlySet<RunId>) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          message("prompt", 0, "user", "turn_start"),
          work("work-before-steer", 4),
          message("steer", 10, "user", "steer"),
          work("work-after-steer", 15),
          message("final", 30, "assistant"),
        ],
        latestRun: { runId, status: "completed", startedAt: time(0), completedAt: time(30) },
        isWorking: false,
        expandedRunIds,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const segmentKey = RunId.make(`${runId}:steer:steer`);
    const collapsed = rows(new Set());
    expect(collapsed.map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "final",
    ]);
    expect(collapsed[1]).toMatchObject({ label: "Worked for 30s" });
    expect(collapsed[3]).toMatchObject({ label: "Continued for 20s", createdAt: time(10) });

    expect(rows(new Set([segmentKey])).map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "work-after-steer",
      "final",
    ]);
  });
});
