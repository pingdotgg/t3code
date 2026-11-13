import {
  DateTime,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  describe,
  expect,
  it,
  type MessagesTimelineRow,
  type TimelineEntry,
} from "./MessagesTimeline.logic-fixtures.ts";

describe("v2 run and attempt history", () => {
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
          runId: null,
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
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
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
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const expandedWork = openedActivity.find((row) => row.kind === "work");
    expect(expandedWork?.kind === "work" ? expandedWork.groupedEntries : []).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });
  it("collapses only output from a superseded V2 attempt within the active logical run", () => {
    const runId = "run-steered" as never;
    const supersededAttemptId = "attempt-1" as never;
    const activeAttemptId = "attempt-2" as never;
    const supersededAttempt = {
      id: supersededAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
      completedAt: null,
    };
    const activeAttempt = {
      id: activeAttemptId,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
      completedAt: null,
    };
    const timelineEntries = [
      {
        id: "context-handoff-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: { type: "handoff", runId },
        } as never,
      },
      {
        id: "initial-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        message: {
          id: "initial-user" as never,
          role: "user" as const,
          text: "Build it",
          runId,
          inputIntent: "turn_start" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:02Z",
        attempt: supersededAttempt,
        message: {
          id: "superseded-assistant" as never,
          role: "assistant" as const,
          text: "Partial old response",
          runId,
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:03Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        attempt: supersededAttempt,
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:04Z",
          runId,
          label: "Old command",
          tone: "tool" as const,
          projectedItem: {
            sourceItemId: "old-work-anchor",
            item: {
              type: "command_execution",
              deferredWork: { cursor: "old-work", itemCount: 200, lastOrdinal: 200 },
            },
          } as never,
        },
      },
      {
        id: "superseded-thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:04.500Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "steer-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        attempt: activeAttempt,
        message: {
          id: "steer-user" as never,
          role: "user" as const,
          text: "Change direction",
          runId,
          inputIntent: "steer" as const,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
      },
      {
        id: "active-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:06Z",
        attempt: activeAttempt,
        message: {
          id: "active-assistant" as never,
          role: "assistant" as const,
          text: "Current response",
          runId,
          createdAt: "2026-01-01T00:00:06Z",
          updatedAt: "2026-01-01T00:00:07Z",
          streaming: true,
        },
      },
    ];
    const common = {
      timelineEntries,
      latestRun: {
        runId,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    const collapsedRows = deriveMessagesTimelineRows(common);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "context-handoff-entry",
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    expect(collapsedRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      attemptId: supersededAttemptId,
      runId,
      label: "Superseded attempt",
      expanded: false,
      deferredWorkItemIds: ["old-work-anchor"],
    });

    const expandedRows = deriveMessagesTimelineRows({
      ...common,
      expandedAttemptIds: new Set([supersededAttemptId]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "context-handoff-entry",
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-assistant-entry",
      "superseded-work-entry",
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    const settledRows = deriveMessagesTimelineRows({
      ...common,
      latestRun: { ...common.latestRun, status: "completed", completedAt: "2026-01-01T00:00:08Z" },
      timelineEntries: timelineEntries.map((entry) =>
        entry.kind === "message" && entry.id === "active-assistant-entry"
          ? { ...entry, message: { ...entry.message, streaming: false } }
          : entry,
      ),
      expandedRunIds: new Set([runId]),
    });
    expect(settledRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      deferredWorkItemIds: ["old-work-anchor"],
    });
    expect(
      settledRows
        .filter((row) => row.kind === "turn-fold")
        .flatMap((row) => row.deferredWorkItemIds ?? []),
    ).not.toContain("old-work-anchor");
    const deferredTailRows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        timelineEntries[0]!,
        timelineEntries[2]!,
        timelineEntries[1]!,
        ...timelineEntries.slice(3),
      ].map((entry) => ({
        ...entry,
        attempt:
          entry.attempt.id === supersededAttemptId
            ? { ...entry.attempt, completedAt: DateTime.makeUnsafe("2026-01-01T00:00:08Z") }
            : entry.attempt,
        ...(entry.id === "superseded-assistant-entry"
          ? {
              projectedItem: {
                item: {
                  type: "assistant_message",
                  ordinal: 2,
                  status: "completed",
                  completedAt: DateTime.makeUnsafe("2026-01-01T00:00:03Z"),
                },
              } as never,
            }
          : {}),
      })),
    });
    expect(deferredTailRows.some((row) => row.kind === "attempt-fold")).toBe(true);
  });

  describe("a steer that supersedes an attempt", () => {
    const runId = RunId.make("run-steered");
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const supersededAttempt = {
      id: RunAttemptId.make("attempt-1"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node-attempt-1"),
      status: "superseded" as const,
      completedAt: DateTime.makeUnsafe(at(10)),
    };
    const nextAttempt = {
      id: RunAttemptId.make("attempt-2"),
      runId,
      attemptOrdinal: 2,
      rootNodeId: NodeId.make("node-attempt-2"),
      status: "completed" as const,
      completedAt: DateTime.makeUnsafe(at(14)),
    };
    const assistantEntry = (
      id: string,
      attempt: typeof supersededAttempt | typeof nextAttempt,
      completedSecond: number,
    ): TimelineEntry => ({
      id,
      kind: "message",
      createdAt: at(2),
      attempt,
      message: {
        id: MessageId.make(id),
        role: "assistant",
        text: `${id} text`,
        runId,
        createdAt: at(2),
        updatedAt: at(completedSecond),
        streaming: false,
      },
      projectedItem: {
        item: {
          type: "assistant_message",
          status: "completed",
          completedAt: DateTime.makeUnsafe(at(completedSecond)),
        },
      } as never,
    });
    const rowsFor = (
      replyCompletedSecond: number,
      runStatus: "running" | "completed" = "completed",
    ) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "initial-user-entry",
            kind: "message",
            createdAt: at(0),
            attempt: supersededAttempt,
            message: {
              id: MessageId.make("initial-user"),
              role: "user",
              text: "Build it",
              runId,
              inputIntent: "turn_start",
              createdAt: at(0),
              updatedAt: at(0),
              streaming: false,
            },
          },
          {
            id: "old-work-entry",
            kind: "work",
            createdAt: at(1),
            attempt: supersededAttempt,
            entry: { id: "old-work", createdAt: at(1), runId, label: "Read", tone: "tool" },
          },
          assistantEntry("old-reply-entry", supersededAttempt, replyCompletedSecond),
          {
            id: "steer-user-entry",
            kind: "message",
            createdAt: at(10),
            attempt: nextAttempt,
            message: {
              id: MessageId.make("steer-user"),
              role: "user",
              text: "What are you working on?",
              runId,
              inputIntent: "steer",
              createdAt: at(10),
              updatedAt: at(10),
              streaming: false,
            },
          },
          assistantEntry("new-reply-entry", nextAttempt, 14),
        ],
        latestRun: {
          runId,
          status: runStatus,
          startedAt: at(0),
          completedAt: runStatus === "completed" ? at(14) : null,
        },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    it.each(["running", "completed"] as const)(
      "keeps a reply that finished before the steer visible while the run is %s",
      (runStatus) => {
        const rows = rowsFor(4, runStatus);
        expect(rows.some((row) => row.kind === "attempt-fold")).toBe(false);
        expect(rows.map((row) => row.id)).toContain("old-reply-entry");
      },
    );

    it("folds a reply the steer cut off as partial output", () => {
      const rows = rowsFor(11, "running");
      expect(rows.find((row) => row.kind === "attempt-fold")).toMatchObject({
        attemptId: supersededAttempt.id,
        label: "Superseded attempt",
      });
      expect(rows.map((row) => row.id)).not.toContain("old-reply-entry");
    });
  });

  it("hides the interruption request while keeping intervening work and the result", () => {
    const runId = "turn-1" as never;
    const interruptEvent = (type: "run_interrupt_request" | "run_interrupt_result") => ({
      position: type === "run_interrupt_request" ? 0 : 2,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-${type}` as never,
      item: {
        id: `item-${type}`,
        threadId: "thread-1",
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: type === "run_interrupt_request" ? 0 : 2,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type,
        message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: interruptEvent("run_interrupt_request") as never,
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:02Z",
            runId,
            label: "Finishing tool output",
            tone: "tool",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["work-entry", "interrupt-result"]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);

    const stoppedRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stopped-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "stopped-command",
            createdAt: "2026-01-01T00:00:01Z",
            runId,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "/bin/bash -lc 'sleep 90 && echo slept'",
            toolLifecycleStatus: "stopped",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(stoppedRows.map((row) => row.id)).toEqual(["stopped-command-entry", "interrupt-result"]);
    expect(stoppedRows[0]).toMatchObject({
      kind: "work",
      displayLabel: "sleep 90 && echo slept",
    });
  });
});

it.each([
  [undefined, ["first"]],
  [["first"], ["second"]],
  [["first"], []],
  [
    ["first", "second"],
    ["second", "first"],
  ],
  [undefined, []],
] as const)("keeps deferred fold anchors current from %j to %j", (before, after) => {
  const row: Extract<MessagesTimelineRow, { kind: "turn-fold" }> = {
    kind: "turn-fold",
    id: "fold",
    runId: RunId.make("run"),
    createdAt: "2026-01-01T00:00:00Z",
    label: "Worked for 1m",
    expanded: true,
    ...(before === undefined ? {} : { deferredWorkItemIds: before }),
  };
  const previous = computeStableMessagesTimelineRows([row], { result: [], byId: new Map() });
  const nextRow = { ...row, deferredWorkItemIds: after };
  const next = computeStableMessagesTimelineRows([nextRow], previous);
  const fold = next.result[0];
  expect(fold?.kind === "turn-fold" ? (fold.deferredWorkItemIds ?? []) : null).toEqual(after);
  expect(
    computeStableMessagesTimelineRows([{ ...nextRow, deferredWorkItemIds: [...after] }], next),
  ).toBe(next);
});
