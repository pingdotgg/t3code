import {
  DateTime,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveTimelineEntriesFromVisibleTurnItems,
  describe,
  expect,
  it,
  type MessagesTimelineRow,
  type TimelineEntry,
} from "./MessagesTimeline.logic-fixtures.ts";

describe("deriveMessagesTimelineRows", () => {
  it("stacks back-to-back steers as one burst with a single steer label", () => {
    const runId = RunId.make("double-steer-run");
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
    const prompt = message("prompt", 0, "user", "turn_start");
    const work: TimelineEntry = {
      kind: "work",
      id: "work",
      createdAt: time(4),
      entry: { id: "work", createdAt: time(4), runId, label: "Ran command", tone: "tool" },
    };
    const firstSteer = message("first-steer", 10, "user", "steer");
    const deriveRows = (timelineEntries: TimelineEntry[]) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestRun: { runId, status: "completed", startedAt: time(0), completedAt: time(30) },
        isWorking: false,
        expandedRunIds: new Set(),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    // The second steer arrives while the first message object is reused, as live updates do.
    const before = computeStableMessagesTimelineRows(deriveRows([prompt, work, firstSteer]), {
      result: [],
      byId: new Map(),
    });
    const rows = computeStableMessagesTimelineRows(
      deriveRows([
        prompt,
        work,
        firstSteer,
        message("second-steer", 12, "user", "steer"),
        message("final", 30, "assistant"),
      ]),
      before,
    ).result;

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("prompt")).not.toHaveProperty("groupedWithNext");
    expect(byId.get("first-steer")).toMatchObject({
      groupedWithNext: true,
      groupedWithPrevious: false,
      continuesSteer: false,
    });
    expect(byId.get("second-steer")).toMatchObject({
      groupedWithNext: false,
      groupedWithPrevious: true,
      continuesSteer: true,
    });
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
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
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
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
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
      "live-activity-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: "thinking" });
  });

  it("does not show Thinking once the open run's provider turn has ended", () => {
    const input = {
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message" as const,
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user" as never,
            role: "user" as const,
            text: "Take over the queue",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    expect(deriveMessagesTimelineRows(input).at(-1)?.kind).toBe("thinking");
    const ended = deriveMessagesTimelineRows({
      ...input,
      latestRun: { ...input.latestRun, turnEnded: true },
    });
    expect(ended.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("keeps a promptless restart in one active visual response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "keep going",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "old-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "old-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-before-restart" as never,
            label: "Searched files",
            command: "rg restart",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "old-stale-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "old-stale-work",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-before-restart" as never,
            label: "Running stale command",
            command: "rg stale",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "old-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:08Z",
          message: {
            id: "old-commentary" as never,
            role: "assistant",
            text: "the server restarted, continuing here.",
            runId: "turn-before-restart" as never,
            createdAt: "2026-01-01T00:00:08Z",
            updatedAt: "2026-01-01T00:00:08Z",
            streaming: false,
          },
        },
        {
          id: "new-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "new-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-after-restart" as never,
            label: "Running tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-after-restart" as never,
        status: "running",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.filter((row) => row.id === "working-indicator-row")).toHaveLength(1);
    expect(rows.findIndex((row) => row.id === "working-indicator-row")).toBeLessThan(
      rows.findIndex((row) => row.id === "old-work-entry"),
    );
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      createdAt: "2026-01-01T00:01:00Z",
    });
    expect(rows.find((row) => row.id === "old-commentary-entry")).toMatchObject({
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: true,
    });
    expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: "new-work" }) }),
    ]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("carries the latest thought on the live row while a later tool runs", () => {
    type WorkEntry = Extract<
      Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"][number],
      { kind: "work" }
    >;
    const work = (
      id: string,
      at: string,
      fields: Omit<WorkEntry["entry"], "id" | "createdAt" | "runId" | "label">,
    ): WorkEntry => ({
      id: `${id}-entry`,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, runId: "turn-1" as never, label: id, ...fields },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("old-thought", "2026-01-01T00:00:01Z", {
          itemType: "reasoning",
          detail: "First idea.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("new-thought", "2026-01-01T00:00:02Z", {
          itemType: "reasoning",
          detail: "Found the cause.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("running-command", "2026-01-01T00:00:03Z", {
          command: "rg cause",
          requestKind: "command",
          tone: "tool" as const,
          toolLifecycleStatus: "inProgress" as const,
        }),
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      thought: { id: "new-thought" },
    });
  });

  it("keeps an actually running tool in the shared activity row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Ran tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      active: true,
      groupedEntries: [
        { id: "running-command" },
        { id: "completed-edit" },
        { id: "completed-command" },
      ],
    });
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    const threadId = ThreadId.make("subagent-child");
    const rootNodeId = NodeId.make("task-root");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 8, 25, 22, 51, second)).toISOString());
    const base = (id: string, ordinal: number, second: number, endSecond = second) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(endSecond),
      updatedAt: at(endSecond),
    });
    const prompt = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "user_message" as const,
      messageId: MessageId.make(id),
      text: `Prompt ${id}`,
      attachments: [],
      inputIntent: "turn_start" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    });
    const answer = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "assistant_message" as const,
      messageId: MessageId.make(id),
      text: `Answer ${id}`,
      streaming: false,
    });
    type ResumeState = "running" | "completed" | "failed";
    const items = (resume: ResumeState) =>
      [
        prompt("launch", 1, 0),
        { ...base("launch-ls", 2, 4), type: "command_execution" as const, input: "ls src" },
        {
          ...base("launch-thinking", 3, 8),
          type: "reasoning" as const,
          title: "Thinking",
          text: "Not there.",
          streaming: false,
        },
        answer("launch-answer", 4, 8),
        prompt("resume", 5, 72),
        {
          ...base("resume-ls", 6, 77),
          type: "command_execution" as const,
          input: "ls src",
          status: resume === "running" ? ("running" as const) : ("completed" as const),
          completedAt: resume === "running" ? null : at(77),
        },
        ...(resume === "failed"
          ? [
              {
                ...base("resume-error", 7, 80),
                type: "error" as const,
                status: "failed" as const,
                failure: {
                  class: "provider_error" as const,
                  message: "Subagent failed",
                  code: null,
                  retryable: null,
                },
              },
            ]
          : []),
        ...(resume === "running" ? [] : [answer("resume-answer", 8, 80)]),
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (input: {
      resume: ResumeState;
      working: boolean;
      expandedRunIds?: ReadonlySet<RunId>;
    }) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(input.resume),
          optimisticMessages: [],
        }),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        ...(input.expandedRunIds === undefined ? {} : { expandedRunIds: input.expandedRunIds }),
        activeTurnStartedAt: input.working ? DateTime.formatIso(at(72)) : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? `fold:${row.label}`
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind,
      );

    const settled = rows({ resume: "completed", working: false });
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s",
      "assistant:resume-answer",
    ]);

    const launchFold = settled.find((row) => row.kind === "turn-fold");
    if (launchFold?.kind !== "turn-fold") throw new Error("Expected the launch fold");
    const expanded = rows({
      resume: "completed",
      working: false,
      expandedRunIds: new Set([launchFold.runId]),
    });
    expect(shape(expanded)).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "work-toggle",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s",
      "assistant:resume-answer",
    ]);

    expect(shape(rows({ resume: "running", working: true }))).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "working",
      "work-live",
    ]);

    expect(shape(rows({ resume: "failed", working: false }))).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "work",
      "work",
      "assistant:resume-answer",
    ]);
  });

  it("keeps answered questions in their own row outside tool groups and turn folds", () => {
    const threadId = ThreadId.make("answered-question-thread");
    const runId = RunId.make("answered-question-run");
    const requestId = RuntimeRequestId.make("scope-question");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 9, 17, 12, 0, second)).toISOString());
    const base = (id: string, ordinal: number, second: number) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(second),
      updatedAt: at(second),
    });
    const command = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "command_execution" as const,
      input: `cat ${id}`,
    });
    const items = (settled: boolean) =>
      [
        {
          ...base("prompt", 0, 0),
          type: "user_message" as const,
          messageId: MessageId.make("prompt"),
          text: "Pick a repository",
          attachments: [],
          inputIntent: "turn_start" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
        },
        command("before", 1, 1),
        {
          ...base("question", 2, 2),
          type: "user_input_request" as const,
          requestId,
          questions: [],
          questionAnswer: {
            requestId,
            questionTextById: { scope: "Which repository?" },
            answers: { scope: "The private one" },
            attachmentsByQuestionId: {},
          },
        },
        command("after", 3, 3),
        settled
          ? {
              ...base("answer", 4, 5),
              type: "assistant_message" as const,
              messageId: MessageId.make("answer"),
              text: "Done",
              streaming: false,
            }
          : { ...command("running", 4, 4), status: "running" as const, completedAt: null },
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (settled: boolean, expandedRunIds?: ReadonlySet<RunId>) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(settled),
          optimisticMessages: [],
        }),
        latestRun: {
          runId,
          status: settled ? "completed" : "running",
          startedAt: DateTime.formatIso(at(0)),
          completedAt: settled ? DateTime.formatIso(at(5)) : null,
        },
        runningRunId: settled ? null : runId,
        isWorking: !settled,
        activeTurnStartedAt: settled ? null : DateTime.formatIso(at(0)),
        ...(expandedRunIds === undefined ? {} : { expandedRunIds }),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? "fold"
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind === "work" || row.kind === "work-live"
              ? `${row.kind}:${row.groupedEntries.map((entry) => entry.id).join(" + ")}`
              : row.kind,
      );

    expect(shape(rows(true))).toEqual(["user:prompt", "fold", "work:question", "assistant:answer"]);
    expect(shape(rows(true, new Set([runId])))).toEqual([
      "user:prompt",
      "fold",
      "work:before",
      "work:question",
      "work:after",
      "assistant:answer",
    ]);
    expect(shape(rows(false))).toEqual([
      "user:prompt",
      "working",
      "work:before",
      "work:question",
      "work-live:after + running",
    ]);
  });
});
