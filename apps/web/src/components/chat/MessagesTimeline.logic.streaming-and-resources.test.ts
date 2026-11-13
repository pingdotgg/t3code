import {
  CheckpointRef,
  DateTime,
  MessageId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  describe,
  expect,
  it,
  makeStreamingTimelineFixture,
  type OrchestrationV2ProjectedTurnItem,
  type TimelineEntry,
  type TurnDiffSummary,
} from "./MessagesTimeline.logic-fixtures.ts";

describe("streaming v2 row projection", () => {
  function fixture(text = "") {
    const source = makeStreamingTimelineFixture(text);
    const timelineInput = { visibleTurnItems: source.visibleTurnItems, optimisticMessages: [] };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
    const input = {
      timelineEntries: timeline.entries,
      latestRun: {
        runId: source.runId,
        status: "running" as const,
        startedAt: source.time(5),
        completedAt: null,
      },
      runningRunId: source.runId,
      isWorking: true,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaries: [
        {
          runId: source.historyRunId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/history"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("history-assistant"),
          completedAt: source.time(4),
        },
      ] satisfies ReadonlyArray<TurnDiffSummary>,
      supportsConversationRollback: true,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { ...source, timelineInput, timeline, input };
  }

  function updateText(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, text: string) {
    return items.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? {
            ...row,
            item: { ...row.item, text, updatedAt: DateTime.makeUnsafe("2026-09-04T00:00:08.000Z") },
          }
        : row,
    );
  }

  it.each([
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ])("keeps row parity and history identity from %j to %j", (before, after) => {
    const initial = fixture(before);
    const previous = deriveMessagesTimelineRowsWithState({
      ...initial.input,
      availableRevertTurnCounts: new Set([0]),
      pendingApprovalRequestIds: new Set<RuntimeRequestId>(),
    });
    Object.freeze(previous.rows);
    for (const row of previous.rows) Object.freeze(row);
    const timelineInput = {
      ...initial.timelineInput,
      visibleTurnItems: updateText(initial.visibleTurnItems, after),
    };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      timelineInput,
      initial.timeline,
    );
    const input = {
      ...initial.input,
      timelineEntries: timeline.entries,
      latestRun: { ...initial.input.latestRun },
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({ ...summary })),
      availableRevertTurnCounts: new Set([0]),
      pendingApprovalRequestIds: new Set<RuntimeRequestId>(),
    };
    const next = deriveMessagesTimelineRowsWithState(input, previous);
    expect(next.rows).toEqual(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
      }),
    );
    for (const [index, row] of previous.rows.entries()) {
      if (
        (row.kind === "message" || row.kind === "assistant-meta") &&
        row.message.id === "live-assistant"
      ) {
        expect(next.rows[index]).toMatchObject({ message: { text: after } });
        expect(next.rows[index]).toHaveProperty(
          "projectedItem",
          timelineInput.visibleTurnItems.at(-1),
        );
        expect(row.message.text).toBe(before);
      } else {
        expect(next.rows[index]).toBe(row);
      }
    }
  });

  it.each(["file", "image", "handoff", "streaming-image"] as const)(
    "keeps history references with %s previews through the v2 materializer",
    (kind) => {
      const initial = fixture("Partial");
      const image = {
        type: "image" as const,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 42,
      };
      const file = {
        type: "file" as const,
        id: "file",
        name: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
      };
      const timelineInput = {
        ...initial.timelineInput,
        visibleTurnItems: initial.visibleTurnItems.map((row, index) =>
          (row.item.type === "user_message" && index === 0) ||
          (row.item.type === "assistant_message" &&
            row.item.streaming &&
            kind === "streaming-image")
            ? {
                ...row,
                item: { ...row.item, attachments: kind === "file" ? [file] : [image, file] },
              }
            : row,
        ),
        attachmentUrlById: new Map([
          [image.id, kind === "handoff" ? "blob:handoff" : "https://server.test/image"],
        ]),
      };
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const previous = deriveMessagesTimelineRowsWithState(input);
      const nextTimelineInput = {
        ...timelineInput,
        visibleTurnItems: updateText(timelineInput.visibleTurnItems, "Next token"),
        attachmentUrlById: new Map(timelineInput.attachmentUrlById),
      };
      const nextTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        nextTimelineInput,
        timeline,
      );
      const nextInput = { ...input, timelineEntries: nextTimeline.entries };
      const next = deriveMessagesTimelineRowsWithState(nextInput, previous);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(nextInput));
      for (const [index, row] of previous.rows.entries()) {
        if (
          (row.kind === "message" || row.kind === "assistant-meta") &&
          row.message.id === "live-assistant"
        )
          continue;
        expect(next.rows[index]).toBe(row);
      }
      const renewedInput = {
        ...nextTimelineInput,
        attachmentUrlById: new Map([[image.id, "https://renewed.test/image"]]),
      };
      const renewedTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        renewedInput,
        nextTimeline,
      );
      const renewedRowsInput = { ...input, timelineEntries: renewedTimeline.entries };
      const renewed = deriveMessagesTimelineRowsWithState(renewedRowsInput, next);
      expect(renewed.rows).toEqual(deriveMessagesTimelineRows(renewedRowsInput));
      if (kind !== "file") {
        expect(renewed.rows.find((row) => row.id === "history-user")).toMatchObject({
          message: { attachments: [{ previewUrl: "https://renewed.test/image" }, file] },
        });
      }
    },
  );

  it("rebuilds for completion, late failure, metadata, expansion, and older history", () => {
    const initial = fixture("Partial");
    let timeline = initial.timeline;
    let timelineInput = initial.timelineInput;
    let input: Parameters<typeof deriveMessagesTimelineRows>[0] = initial.input;
    let projection = deriveMessagesTimelineRowsWithState(input);
    const check = (changes: Partial<typeof input> = {}) => {
      const previous = projection;
      timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
      input = { ...input, ...changes, timelineEntries: timeline.entries };
      projection = deriveMessagesTimelineRowsWithState(input, previous);
      expect(projection.rows).toEqual(
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
        }),
      );
      expect(previous.rows).toEqual(deriveMessagesTimelineRows(previous.input));
    };
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? {
              ...row,
              item: {
                ...row.item,
                streaming: false,
                status: "completed",
                text: "Complete",
                updatedAt: DateTime.makeUnsafe(initial.time(9)),
              },
            }
          : row,
      ),
    };
    check({
      latestRun: { ...initial.input.latestRun, status: "completed", completedAt: initial.time(9) },
      runningRunId: null,
      isWorking: false,
    });
    const lateFailure = initial.visibleTurnItems[1]!;
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        ...timelineInput.visibleTurnItems,
        {
          ...lateFailure,
          position: 6,
          sourceItemId: TurnItemId.make("late-failure"),
          item: {
            ...lateFailure.item,
            id: TurnItemId.make("late-failure"),
            runId: initial.runId,
            ordinal: 10,
            startedAt: DateTime.makeUnsafe(initial.time(10)),
          },
        },
      ],
    };
    check();
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.messageId === "live-assistant"
          ? {
              ...row,
              item: {
                ...row.item,
                text: "Corrected final text",
                updatedAt: DateTime.makeUnsafe(initial.time(11)),
              },
            }
          : row,
      ),
    };
    check();
    check({
      latestRun: {
        ...initial.input.latestRun,
        status: "interrupted",
        completedAt: initial.time(12),
      },
    });
    check({ expandedRunIds: new Set([initial.historyRunId, initial.runId]) });
    const group = projection.rows.find((row) => row.kind === "work-toggle");
    check({ expandedWorkGroupIds: new Set(group ? [group.groupId] : []) });
    const first = initial.visibleTurnItems[0]!;
    if (first.item.type !== "user_message") throw new Error("Expected user fixture");
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        {
          ...first,
          sourceItemId: TurnItemId.make("older-user-item"),
          item: {
            ...first.item,
            id: TurnItemId.make("older-user-item"),
            messageId: MessageId.make("older-user"),
            startedAt: DateTime.makeUnsafe(initial.time(-60)),
          },
        },
        ...timelineInput.visibleTurnItems,
      ].map((row, position) => ({ ...row, position })),
    };
    check();
    check({ supportsConversationRollback: false });
    check({
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({
        ...summary,
        status: "stale" as const,
      })),
    });
  });
});

describe("linked timeline resources", () => {
  const runId = RunId.make("resource-run");
  const event = (id: string, type: "subagent" | "thread_created", eventRunId = runId) => ({
    id,
    kind: "event" as const,
    createdAt: "2026-09-08T10:00:02Z",
    projectedItem: { item: { id, type, runId: eventRunId } } as OrchestrationV2ProjectedTurnItem,
  });
  const common = { isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false };

  it("groups adjacent subagents without merging across a resource or run boundary", () => {
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        event("a", "subagent"),
        event("b", "subagent"),
        event("c", "thread_created"),
        event("d", "subagent"),
        event("e", "subagent", RunId.make("other-run")),
      ],
      expandedRunIds: new Set([runId, RunId.make("other-run")]),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "a",
      "c",
      "d",
      "turn-fold:other-run",
      "e",
    ]);
    expect(rows[1]).toMatchObject({ subagents: [{ item: { id: "a" } }, { item: { id: "b" } }] });
  });

  it.each([
    { status: "completed", envelope: "direct", role: "general" },
    { status: "completed", envelope: "structured", role: "general" },
    { status: "completed", envelope: "text", role: "general" },
    { status: "completed", envelope: "structured", role: "research" },
    { status: "running", envelope: "direct", role: "general" },
    { status: "running", envelope: "direct", role: "research" },
  ] as const)(
    "matches $status $role delegation calls by child identity with $envelope output",
    ({ status, envelope, role }) => {
      const child = (id: string) => {
        const entry = event(id, "subagent");
        return {
          ...entry,
          projectedItem: {
            item: {
              ...entry.projectedItem.item,
              origin: "app_owned",
              subagentId: id,
              prompt:
                role === "general" ? id : `Act as the ${role} sub-agent for this task.\n\n${id}`,
              childThreadId: null,
            },
          } as OrchestrationV2ProjectedTurnItem,
        };
      };
      const delegation = (id: string, taskId: string, failed = false): TimelineEntry => ({
        id,
        kind: "work",
        createdAt: "2026-09-08T10:00:02Z",
        entry: {
          id,
          runId,
          createdAt: "2026-09-08T10:00:02Z",
          label: "Delegated a child task",
          tone: failed ? "error" : "tool",
          itemType: "dynamic_tool",
          toolLifecycleStatus: failed
            ? "failed"
            : status === "running"
              ? "inProgress"
              : "completed",
          projectedItem: {
            item: {
              id,
              runId,
              type: "dynamic_tool",
              status: failed ? "failed" : status,
              toolName: "t3-code.delegate_task",
              input: { task: taskId === "b" ? "a" : taskId, role },
              ...(status === "completed"
                ? {
                    output:
                      envelope === "structured"
                        ? { content: JSON.stringify({ taskId }), structuredContent: { taskId } }
                        : envelope === "text"
                          ? { content: [{ type: "text", text: JSON.stringify({ taskId }) }] }
                          : { taskId },
                  }
                : {}),
            },
          } as OrchestrationV2ProjectedTurnItem,
        },
      });
      const rows = deriveMessagesTimelineRows({
        ...common,
        isWorking: status === "running",
        runningRunId: status === "running" ? runId : null,
        timelineEntries: [
          child("a"),
          delegation("delegate-a", "a"),
          ...(status === "completed" ? [child("b")] : []),
          delegation("delegate-b", "b"),
          delegation("unmatched", "other-child"),
          child("c"),
          delegation("failed", "c", true),
          child("d"),
        ],
        expandedRunIds: new Set([runId]),
      });
      if (status === "completed") {
        expect(rows.find((row) => row.id === "a")).toMatchObject({
          subagents: [{ item: { id: "a" } }, { item: { id: "b" } }],
        });
        expect(rows.some((row) => row.id === "b")).toBe(false);
      } else {
        expect(rows.find((row) => row.id === "a")).toBeDefined();
        expect(rows.find((row) => row.id === "b")).toBeUndefined();
      }
      expect(rows.find((row) => row.id === "c")).toBeDefined();
      expect(rows.find((row) => row.id === "d")).toBeDefined();
      const visibleTools = rows.flatMap((row) =>
        row.kind === "work" || row.kind === "work-live"
          ? row.groupedEntries.map((entry) => entry.id)
          : [],
      );
      expect(visibleTools).toContain("unmatched");
      expect(visibleTools).toContain("failed");
      expect(visibleTools.includes("delegate-a")).toBe(status === "running");
      expect(visibleTools.includes("delegate-b")).toBe(status === "running");
    },
  );

  it("keeps created-chat summaries after the final answer and folds only their timeline rows", () => {
    const timelineEntries = [
      {
        kind: "message" as const,
        id: "intro",
        createdAt: "2026-09-08T10:00:00Z",
        message: {
          id: MessageId.make("intro"),
          role: "assistant" as const,
          text: "Creating the chat",
          runId,
          streaming: false,
          createdAt: "2026-09-08T10:00:00Z",
          updatedAt: "2026-09-08T10:00:00Z",
        },
      },
      event("created", "thread_created"),
      {
        kind: "message" as const,
        id: "final",
        createdAt: "2026-09-08T10:00:04Z",
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Chat is ready",
          runId,
          streaming: false,
          createdAt: "2026-09-08T10:00:04Z",
          updatedAt: "2026-09-08T10:00:04Z",
        },
      },
    ];
    const collapsed = deriveMessagesTimelineRows({ ...common, timelineEntries });
    expect(collapsed.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
    expect(collapsed.find((row) => row.id === "summary:created")).toMatchObject({
      resourceSummary: true,
    });
    const expanded = deriveMessagesTimelineRows({
      ...common,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(expanded.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "intro",
      "created",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
  });

  it("shows a created chat after a steer only when that steer's segment is open", () => {
    const message = (id: string, role: "user" | "assistant", second: number) => ({
      kind: "message" as const,
      id,
      createdAt: `2026-09-08T10:00:0${second}Z`,
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId,
        ...(role === "user" ? { inputIntent: "steer" as const } : {}),
        streaming: false,
        createdAt: `2026-09-08T10:00:0${second}Z`,
        updatedAt: `2026-09-08T10:00:0${second}Z`,
      },
    });
    const timelineEntries = [
      message("intro", "assistant", 0),
      message("steer", "user", 1),
      event("created", "thread_created"),
      message("after-steer", "assistant", 3),
      message("final", "assistant", 4),
    ];
    const segmentKey = RunId.make(`${runId}:steer:steer`);
    const rowIds = (expanded: RunId[]) =>
      deriveMessagesTimelineRows({
        ...common,
        timelineEntries,
        expandedRunIds: new Set(expanded),
      }).map((row) => row.id);
    expect(rowIds([runId])).not.toContain("created");
    expect(rowIds([segmentKey])).toEqual([
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "created",
      "after-steer",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
  });
});
