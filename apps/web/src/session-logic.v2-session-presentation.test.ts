import {
  MessageId,
  RuntimeRequestId,
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveCanInterruptRunningThread,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  deriveRevertTurnCountByUserMessageId,
  derivePhase,
  isLatestRunSettled,
  selectHandoffImageResources,
  selectMessageImageResources,
  createMessageAttachmentPreviewProjector,
  providerErrorPresentation,
  type TimelineEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./session-logic";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "./test-fixtures";
import type { ChatMessage } from "./types";

describe("V2 session presentation", () => {
  it("resolves attempt identity through V2 execution nodes", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const threadId = ThreadId.make("thread-attempts");
    const runId = RunId.make("run-steered");
    const supersededRootNodeId = NodeId.make("node-attempt-1-root");
    const supersededChildNodeId = NodeId.make("node-attempt-1-child");
    const activeRootNodeId = NodeId.make("node-attempt-2-root");
    const supersededAttemptId = RunAttemptId.make("attempt-1");
    const activeAttemptId = RunAttemptId.make("attempt-2");
    const providerInstanceId = ProviderInstanceId.make("codex-default");
    const providerThreadId = ProviderThreadId.make("provider-thread-attempts");
    const attempts: ReadonlyArray<OrchestrationV2RunAttempt> = [
      {
        id: supersededAttemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: supersededRootNodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "superseded",
        startedAt: now,
        completedAt: now,
      },
      {
        id: activeAttemptId,
        runId,
        attemptOrdinal: 2,
        rootNodeId: activeRootNodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "steering_restart",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    ];
    const node = (
      id: OrchestrationV2ExecutionNode["id"],
      rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"],
      parentNodeId: OrchestrationV2ExecutionNode["parentNodeId"],
    ): OrchestrationV2ExecutionNode => ({
      id,
      threadId,
      runId,
      parentNodeId,
      rootNodeId,
      kind: id === rootNodeId ? "root_turn" : "assistant_message",
      status: "running",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    });
    const nodes = [
      node(supersededRootNodeId, supersededRootNodeId, null),
      node(supersededChildNodeId, supersededRootNodeId, supersededRootNodeId),
      node(activeRootNodeId, activeRootNodeId, null),
    ];
    const assistantItem = (
      id: string,
      messageId: string,
      nodeId: NodeId,
      text: string,
      ordinal: number,
    ): OrchestrationV2TurnItem => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(messageId),
      text,
      streaming: true,
    });
    const items = [
      assistantItem(
        "item-superseded",
        "message-superseded",
        supersededChildNodeId,
        "Partial old response",
        0,
      ),
      assistantItem("item-active", "message-active", activeRootNodeId, "Current response", 1),
    ];
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = items.map(
      (item, position) => ({
        position,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }),
    );

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
      attempts,
      nodes,
    });

    expect(entries.map((entry) => [entry.attempt?.id, entry.attempt?.status])).toEqual([
      [supersededAttemptId, "superseded"],
      [activeAttemptId, "running"],
    ]);
    const input = { visibleTurnItems, optimisticMessages: [], attempts, nodes };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = {
      ...input,
      attempts: attempts.map((attempt) =>
        attempt.id === activeAttemptId ? { ...attempt, status: "superseded" as const } : attempt,
      ),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)?.attempt?.status).toBe("superseded");
    expect(previous.entries.at(-1)?.attempt?.status).toBe("running");
  });
});

describe("V2 session presentation", () => {
describe("revert targets after a rewind", () => {
    const runId = (ordinal: number) => RunId.make(`run-${ordinal}`);

    const turn = (ordinal: number): TimelineEntry[] =>
      (["user", "assistant"] as const).map((role) => {
        const id = MessageId.make(`${role}-${ordinal}`);
        const createdAt = `2026-06-20T00:00:0${ordinal}.000Z`;
        return {
          id,
          kind: "message",
          createdAt,
          message: {
            id,
            role,
            text: role,
            runId: runId(ordinal),
            ...(role === "user" ? { inputIntent: "turn_start" as const } : {}),
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        };
      });

    const checkpoint = (ordinal: number, status: "ready" | "stale" = "ready") => ({
      runId: runId(ordinal),
      checkpointTurnCount: ordinal,
      checkpointRef: `checkpoint-${ordinal}` as never,
      status,
      files: [],
      assistantMessageId: MessageId.make(`assistant-${ordinal}`),
      completedAt: "2026-06-20T00:00:09.000Z",
    });

    const targets = (
      ordinals: ReadonlyArray<number>,
      checkpoints: ReadonlyArray<ReturnType<typeof checkpoint>>,
      options: { threadStartCheckpointReady?: boolean; unsettledRunId?: RunId } = {},
    ) =>
      Object.fromEntries(
        deriveRevertTurnCountByUserMessageId({
          timelineEntries: ordinals.flatMap(turn),
          checkpoints,
          threadStartCheckpointReady: options.threadStartCheckpointReady ?? true,
          unsettledRunId: options.unsettledRunId ?? null,
        }),
      );

    it("keeps rewound and stopped runs editable at the previous visible checkpoint", () => {
      // Runs 1 and 3 were rewound; run 5 stopped without capturing a checkpoint.
      expect(targets([2, 4, 5], [checkpoint(2), checkpoint(3, "stale"), checkpoint(4)])).toEqual({
        "user-2": 0,
        "user-4": 2,
        "user-5": 4,
      });
      expect(targets([2], [checkpoint(1, "stale")])).toEqual({ "user-2": 0 });
    });

    it("preserves a notification-only wake run while ignoring inherited and unrelated work", () => {
      const fixture = makeStreamingTimelineFixture();
      const first = fixture.visibleTurnItems[0]!;
      if (first.item.type !== "user_message") throw new Error("Expected a user message fixture.");
      const notification = {
        ...first,
        item: {
          ...first.item,
          id: TurnItemId.make("wake-item"),
          runId: runId(2),
          type: "notification" as const,
          source: { kind: "delegated_task" as const, taskIds: [NodeId.make("task-1")] },
          outcome: "unknown" as const,
          summary: "Delegated task finished",
        },
      };
      const inherited = {
        ...notification,
        visibility: "inherited" as const,
        sourceThreadId: ThreadId.make("parent-thread"),
        sourceItemId: TurnItemId.make("inherited-wake"),
        item: {
          ...notification.item,
          id: TurnItemId.make("inherited-wake"),
          threadId: ThreadId.make("parent-thread"),
          runId: runId(7),
        },
      };
      const work: TimelineEntry = {
        id: "background-work",
        kind: "work",
        createdAt: "2026-06-20T00:00:02.000Z",
        entry: {
          id: "background-work",
          createdAt: "2026-06-20T00:00:02.000Z",
          runId: runId(8),
          itemType: "command_execution",
          label: "Background work",
          tone: "tool",
        },
      };

      expect(
        Object.fromEntries(
          deriveRevertTurnCountByUserMessageId({
            timelineEntries: [
              ...turn(1),
              ...deriveTimelineEntriesFromVisibleTurnItems({
                visibleTurnItems: [notification, inherited],
                optimisticMessages: [],
              }),
              work,
              ...turn(3),
            ],
            checkpoints: [
              checkpoint(1),
              checkpoint(2),
              checkpoint(3),
              checkpoint(7),
              checkpoint(8),
            ],
            threadStartCheckpointReady: true,
          }),
        ),
      ).toEqual({ "user-1": 0, "user-3": 2 });
    });

    it("hides edit when the predecessor is unavailable or the run is unsettled", () => {
      expect(targets([1, 2], [checkpoint(2)])).toEqual({ "user-1": 0 });
      expect(targets([1, 2], [checkpoint(1, "stale"), checkpoint(2)])).toEqual({ "user-1": 0 });
      // Earlier history is paged out, so the first loaded run's predecessor is unknown.
      expect(
        targets([4, 5], [checkpoint(4), checkpoint(5)], { threadStartCheckpointReady: false }),
      ).toEqual({ "user-5": 4 });
      expect(targets([1, 2], [checkpoint(1), checkpoint(2)], { unsettledRunId: runId(2) })).toEqual(
        { "user-1": 0 },
      );
    });

    it("can edit a cancelled run but cannot target its checkpoint without a provider turn", () => {
      expect(
        Object.fromEntries(
          deriveRevertTurnCountByUserMessageId({
            timelineEntries: [1, 2, 3].flatMap(turn),
            checkpoints: [checkpoint(1), checkpoint(2), checkpoint(3)],
            threadStartCheckpointReady: true,
            availableRevertTurnCounts: new Set([0, 1]),
          }),
        ),
      ).toEqual({ "user-1": 0, "user-2": 1 });
    });

    it("leaves inherited history uneditable and restores the first local run to thread start", () => {
      const fixture = makeStreamingTimelineFixture();
      const inheritedEntries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: fixture.visibleTurnItems
          .filter(({ item }) => item.runId === fixture.historyRunId)
          .map((item) => ({ ...item, visibility: "inherited" as const })),
        optimisticMessages: [],
      });
      expect(
        Object.fromEntries(
          deriveRevertTurnCountByUserMessageId({
            timelineEntries: [...inheritedEntries, ...turn(2)],
            checkpoints: [{ ...checkpoint(7), runId: fixture.historyRunId }, checkpoint(2)],
            threadStartCheckpointReady: true,
          }),
        ),
      ).toEqual({ "user-2": 0 });
    });
});
});

describe("native provider presentation in the v2 timeline", () => {
  const timestamp = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const base = {
    id: TurnItemId.make("native-item"),
    threadId: ThreadId.make("native-thread"),
    runId: RunId.make("native-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
  const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });

  it("keeps async answers in the question row, including incrementally appended replies", () => {
    const requestId = RuntimeRequestId.make("question");
    const question: OrchestrationV2TurnItem = {
      ...base,
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
    };
    const reply: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("answer"),
      type: "user_message",
      messageId: MessageId.make(`async-answer:${requestId}`),
      inputIntent: "steer",
      text: "Which color?\nBlue",
      createdBy: "user",
      creationSource: "server",
      attachments: [],
    };
    const input = { visibleTurnItems: [visible(question)], optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, visible(reply)] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries).toHaveLength(1);
    const replyFirst = { ...input, visibleTurnItems: [visible(reply)] };
    const replyProjection = deriveTimelineEntriesFromVisibleTurnItemsWithState(replyFirst);
    const questionAfterReply = {
      ...input,
      visibleTurnItems: [...replyFirst.visibleTurnItems, visible(question)],
    };
    expect(
      deriveTimelineEntriesFromVisibleTurnItemsWithState(questionAfterReply, replyProjection)
        .entries,
    ).toEqual(deriveTimelineEntriesFromVisibleTurnItems(questionAfterReply));

    expect(next.entries[0]).toMatchObject({
      kind: "work",
      entry: { questionAnswer: question.questionAnswer },
    });
    expect(
      deriveTimelineEntriesFromVisibleTurnItems({ ...input, visibleTurnItems: [visible(reply)] })[0]
        ?.kind,
    ).toBe("message");
  });

  it("excludes checkpoint-only work from the timeline", () => {
    const message: OrchestrationV2TurnItem = {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make("done"),
      text: "Done",
      streaming: false,
    };
    const checkpoint: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("checkpoint"),
      type: "checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      scopeId: CheckpointScopeId.make("scope"),
      files: [],
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(message), visible(checkpoint)],
      optimisticMessages: [],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["message"]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId: base.runId,
        status: "completed",
        startedAt: DateTime.formatIso(timestamp),
        completedAt: DateTime.formatIso(timestamp),
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.kind)).toEqual(["message"]);
  });

  it.each([
    { outputIndicatesFailure: true },
    { exitCode: 2 },
    { output: "bash: foo: command not found" },
  ])("keeps completed command failures visible without exposing output: %j", (result) => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "foo",
      ...result,
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    if (entry?.kind !== "work") throw new Error("Expected a command work entry");

    expect(entry.entry.detail).toBeUndefined();
    expect(entry.entry.command).toBe("foo");
    expect(entry.entry.toolLifecycleStatus).toBe("completed");
    expect(workEntryDisplayIndicatesToolFailure(entry.entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry.entry)).toBe(false);
  });
});

describe("HTML renders in the timeline", () => {
  const runId = RunId.make("render-run");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-09-04T12:00:${String(second).padStart(2, "0")}.000Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("render-thread"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });
  const htmlRender = { attachmentId: "render-thread-chart.html", title: "Chart", height: 420 };
  const renderCall = (
    status: OrchestrationV2TurnItem["status"],
    output?: unknown,
  ): OrchestrationV2TurnItem => ({
    ...base("render", 2),
    status,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: { title: "Chart", height: 420 },
    ...(output === undefined ? {} : { output }),
  });
  const command = (id: string, second: number): OrchestrationV2TurnItem => ({
    ...base(id, second),
    type: "command_execution",
    input: "vp test run",
  });
  const turn = (render: OrchestrationV2TurnItem) => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base("prompt", 0),
        type: "user_message",
        messageId: MessageId.make("prompt"),
        inputIntent: "turn_start",
        text: "Chart it",
        createdBy: "user",
        creationSource: "server",
        attachments: [],
      },
      command("before", 1),
      render,
      command("after", 3),
      {
        ...base("reply", 4),
        type: "assistant_message",
        messageId: MessageId.make("reply"),
        text: "Here it is.",
        streaming: false,
      },
    ];
    return deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map(visible),
      optimisticMessages: [],
    });
  };
  const rowsFor = (entries: TimelineEntry[], expanded: boolean) =>
    deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId,
        status: "completed",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: DateTime.formatIso(at(5)),
      },
      ...(expanded ? { expandedRunIds: new Set([runId]) } : {}),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    }).map((row) => row.kind);

  it("shows a completed render in place, above the reply, through the turn fold", () => {
    const entries = turn(
      renderCall("completed", { structuredContent: { htmlRender }, content: [] }),
    );
    expect(entries.find((entry) => entry.kind === "html-render")).toMatchObject({
      id: "render",
      runId,
      htmlRender,
    });
    expect(rowsFor(entries, false)).toEqual(["message", "turn-fold", "html-render", "message"]);
    expect(rowsFor(entries, true)).toEqual([
      "message",
      "turn-fold",
      "work",
      "html-render",
      "work",
      "message",
    ]);
  });

  it("hosts a captured MCP app in place, from any provider's tool", () => {
    const mcpApp = {
      attachmentId: "render-thread-app-html",
      server: "weather",
      tool: "get_weather",
      resourceUri: "ui://weather/dashboard",
    };
    const call = renderCall("completed", { t3McpApp: mcpApp, result: { content: [] } });
    const entries = turn(
      call.type === "dynamic_tool" ? { ...call, toolName: "weather.get_weather" } : call,
    );
    expect(entries.find((entry) => entry.kind === "mcp-app")).toMatchObject({
      id: "render",
      itemId: "render",
      mcpApp,
    });
    expect(rowsFor(entries, false)).toEqual(["message", "turn-fold", "mcp-app", "message"]);
  });

  it("hosts an MCP app whose call failed, as a form-deferring write does", () => {
    const mcpApp = {
      attachmentId: "render-thread-app-html",
      server: "github",
      tool: "create_pull_request",
      resourceUri: "ui://github-mcp-server/pr-create",
    };
    const call = renderCall("failed", {
      t3McpApp: mcpApp,
      result: { content: [], isError: true },
    });
    const entries = turn(
      call.type === "dynamic_tool" ? { ...call, toolName: "github.create_pull_request" } : call,
    );
    expect(entries.find((entry) => entry.kind === "mcp-app")).toMatchObject({ mcpApp });
  });

  it("keeps a render visible when its superseded attempt folds", () => {
    const attempt: OrchestrationV2RunAttempt = {
      id: RunAttemptId.make("attempt-superseded"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node-superseded"),
      providerInstanceId: ProviderInstanceId.make("codex-default"),
      providerThreadId: ProviderThreadId.make("provider-thread"),
      providerTurnId: null,
      reason: "initial",
      status: "superseded",
      startedAt: at(0),
      completedAt: at(4),
    };
    const entries = turn(
      renderCall("completed", { structuredContent: { htmlRender }, content: [] }),
    ).map((entry) =>
      entry.kind === "message" && entry.message.role === "user" ? entry : { ...entry, attempt },
    );
    expect(rowsFor(entries, true)).toEqual(["message", "turn-fold", "attempt-fold", "html-render"]);
  });

  it.each([
    ["running", "running", undefined],
    ["failed", "failed", { content: [{ type: "text", text: "Invalid HTML" }], isError: true }],
    ["errored", "completed", { structuredContent: { htmlRender }, isError: true }],
  ] as const)("keeps a %s call in the work log", (_label, status, output) => {
    const entries = turn(renderCall(status, output));
    expect(entries.some((entry) => entry.kind === "html-render")).toBe(false);
    expect(entries.find((entry) => entry.id === "render")?.kind).toBe("work");
  });
});

describe("work-log failure policy (#7999/#7893)", () => {
  const toolEntry = (overrides: Record<string, unknown>) =>
    ({
      id: "entry-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      label: "Ran command",
      tone: "tool",
      ...overrides,
    }) as never;

  it("flags success-status rows whose output text reports a failure", () => {
    expect(
      workEntryIndicatesToolFailure(
        toolEntry({ toolLifecycleStatus: "completed", detail: "bash: foo: command not found" }),
      ),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure(
        toolEntry({ toolLifecycleStatus: "completed", detail: "<exited with exit code 2>" }),
      ),
    ).toBe(true);
  });

  it("keeps the rendered row calm when only the command mentions failure text", () => {
    const entry = toolEntry({
      toolLifecycleStatus: "completed",
      command: "rg 'command not found' src/",
    });
    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });
});
