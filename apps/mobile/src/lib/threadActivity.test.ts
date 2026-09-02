import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  threadFeedActivityIsVisible,
  threadFeedRunIsUnsettled,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  isPendingUserInputOptionSelected,
  buildPendingUserInputAnswers,
} from "./threadActivity";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

it("keeps historical plan detail accessible from its paged turn item", () => {
  const item = {
    ...base("historical-plan", "2026-08-29T00:00:00.000Z", 1),
    type: "proposed_plan",
    planId: "plan-historical",
    markdown: "Full historical plan text",
    streaming: false,
  } as OrchestrationV2TurnItem;

  const entries = buildThreadFeed([projected(item, 0)]);
  const activity = entries.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0];
  expect(activity?.detail).toBe("Full historical plan text");
  expect(activity?.getFullDetail()).toContain("Full historical plan text");
});

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
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
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

function userMessage(updatedAt = "2026-06-20T00:00:01.000Z") {
  return {
    ...base("item-user", updatedAt, 0),
    type: "user_message" as const,
    messageId: MessageId.make("message-user"),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: "Run checks",
    attachments: [],
  };
}

function command(updatedAt = "2026-06-20T00:00:02.000Z") {
  return {
    ...base("item-command", updatedAt, 1),
    type: "command_execution" as const,
    input: "vp check",
    output: "ok",
    exitCode: 0,
  };
}

function assistantMessage(updatedAt = "2026-06-20T00:00:03.000Z") {
  return {
    ...base("item-assistant", updatedAt, 2),
    type: "assistant_message" as const,
    messageId: MessageId.make("message-assistant"),
    text: "Done",
    streaming: false,
  };
}

describe("buildThreadFeed", () => {
  it("adds local feedback messages to an otherwise server-authored feed", () => {
    const feed = buildThreadFeed([], {
      localMessages: [
        {
          id: MessageId.make("feedback-local"),
          role: "assistant",
          text: "Feedback sent to OpenAI.\n\nThread ID: `codex-thread-1`",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z",
        },
      ],
    });

    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: "message",
      message: {
        id: "feedback-local",
        role: "assistant",
        text: expect.stringContaining("codex-thread-1"),
      },
    });
  });

  it("anchors feedback before later committed turns and appends true optimistic messages", () => {
    const laterUser = {
      ...userMessage("2026-08-29T00:00:05.000Z"),
      id: TurnItemId.make("item-later-user"),
      messageId: MessageId.make("message-later-user"),
      ordinal: 2,
      text: "Later user turn",
    };
    const laterAssistant = {
      ...assistantMessage("2026-08-29T00:00:04.000Z"),
      id: TurnItemId.make("item-later-assistant"),
      messageId: MessageId.make("message-later-assistant"),
      ordinal: 3,
      text: "Later assistant turn",
    };
    const localMessage = (id: string, role: "user" | "assistant") => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId: null,
      streaming: false,
      createdAt: "2026-08-29T00:00:03.000Z",
      updatedAt: "2026-08-29T00:00:03.000Z",
    });
    const feed = buildThreadFeed(
      [
        projected(userMessage("2026-08-29T00:00:01.000Z"), 0),
        projected(laterUser, 1),
        projected(laterAssistant, 2),
      ],
      {
        anchoredMessages: [
          localMessage("feedback-user", "user"),
          localMessage("feedback-assistant", "assistant"),
          localMessage("message-later-user", "user"),
        ],
        localMessages: [
          {
            ...localMessage("optimistic-user", "user"),
            createdAt: "2026-08-29T00:00:00.000Z",
          },
        ],
      },
    );
    const messages = feed.filter((entry) => entry.type === "message");

    expect(messages.map((entry) => entry.id)).toEqual([
      "message-user",
      "feedback-user",
      "feedback-assistant",
      "message-later-user",
      "message-later-assistant",
      "optimistic-user",
    ]);
    expect(
      messages
        .filter((entry) => entry.id.startsWith("feedback-"))
        .every((entry) => entry.message.projectedItem === undefined),
    ).toBe(true);
  });

  it("keeps prominent activity visible while it is running", () => {
    expect(
      threadFeedActivityIsVisible({ prominent: true, status: "neutral", toolLike: true }),
    ).toBe(true);
    expect(
      threadFeedActivityIsVisible({ prominent: false, status: "neutral", toolLike: true }),
    ).toBe(false);
  });

  it("presents provider retries as visible work-log activity", () => {
    const retryBase = {
      ...base("item-provider-retry", "2026-06-20T00:00:02.000Z", 1),
      type: "error" as const,
      failure: {
        class: "transport_error" as const,
        message: "The response stream disconnected.",
        code: "responseStreamDisconnected",
        retryable: true,
      },
      retry: {
        attempt: 2,
        maxAttempts: 5,
        retryDelayMs: null,
      },
    };
    const runningFeed = buildThreadFeed([
      projected(
        {
          ...retryBase,
          status: "running",
          title: "Provider retry",
          completedAt: null,
        },
        0,
      ),
    ]);
    const recoveredFeed = buildThreadFeed([
      projected(
        {
          ...retryBase,
          status: "completed",
          title: "Provider recovered",
        },
        0,
      ),
    ]);
    const failedFeed = buildThreadFeed([
      projected(
        {
          ...retryBase,
          status: "failed",
          title: "Provider retry failed",
        },
        0,
      ),
      projected(command("2026-06-20T00:00:03.000Z"), 1),
    ]);
    const runningActivity = runningFeed.find((entry) => entry.type === "activity-group")
      ?.activities[0];
    const recoveredActivity = recoveredFeed.find((entry) => entry.type === "activity-group")
      ?.activities[0];
    if (runningActivity === undefined || recoveredActivity === undefined) {
      throw new Error("Expected provider retry work-log activities.");
    }

    expect(runningActivity).toMatchObject({
      summary: "Provider retry",
      status: "neutral",
      toolLike: false,
    });
    expect(threadFeedActivityIsVisible(runningActivity)).toBe(true);
    expect(recoveredActivity).toMatchObject({
      summary: "Provider recovered",
      status: "success",
      toolLike: false,
    });
    const failedPresentation = deriveThreadFeedPresentation(
      failedFeed,
      { runId, status: "running", startedAt: null, completedAt: null },
      new Set(),
    );
    expect(failedPresentation.map((entry) => entry.type)).toEqual([
      "activity-group",
      "work-toggle",
    ]);
    expect(
      failedPresentation[0]?.type === "activity-group"
        ? failedPresentation[0].activities[0]?.summary
        : null,
    ).toBe("Provider retry failed");
  });

  it("hides synthetic workspace preparation activity", () => {
    const workspacePreparation = projected(
      {
        ...command(),
        title: "Workspace ready",
        input: "Preparing workspace",
        output: "Workspace preparation completed.",
      },
      0,
    );

    expect(buildThreadFeed([workspacePreparation])).toEqual([]);
  });

  it("does not treat a queued-only run as live feed activity", () => {
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "queued",
        startedAt: null,
        completedAt: null,
      }),
    ).toBe(false);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "waiting",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
  });

  it("adds queued input only after dispatch creates its turn item", () => {
    const dispatchedRunId = RunId.make("run-dispatched-queued");
    const dispatchedMessageId = MessageId.make("message-dispatched-queued");
    expect(buildThreadFeed([])).toEqual([]);

    const promotedEntries = buildThreadFeed([
      projected(
        {
          ...userMessage(),
          id: TurnItemId.make("item-dispatched-queued"),
          runId: dispatchedRunId,
          messageId: dispatchedMessageId,
          inputIntent: "turn_start",
        },
        0,
      ),
    ]);
    expect(promotedEntries.map((entry) => entry.id)).toEqual([dispatchedMessageId]);
    expect(
      promotedEntries[0]?.type === "message" ? promotedEntries[0].message.inputIntent : undefined,
    ).toBe("turn_start");
  });

  it("hides the interruption request and keeps the terminal result", () => {
    const request = projected(
      {
        ...base("item-interrupt-request", "2026-06-20T00:00:02.000Z", 1),
        type: "run_interrupt_request",
        message: "Interrupt requested",
      },
      0,
    );
    const result = projected(
      {
        ...base("item-interrupt-result", "2026-06-20T00:00:03.000Z", 2),
        type: "run_interrupt_result",
        message: "Run interrupted before provider start",
      },
      1,
    );

    const activities = buildThreadFeed([request, result]).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]?.summary).toBe("Run interrupted");
    expect(activities[0]?.detail).toBe("Run interrupted before provider start");
    expect(
      deriveThreadFeedPresentation(
        buildThreadFeed([request, result]),
        {
          runId,
          status: "interrupted",
          startedAt: "2026-06-20T00:00:01.000Z",
          completedAt: "2026-06-20T00:00:03.000Z",
        },
        new Set(),
      ).some((entry) => entry.type === "run-fold"),
    ).toBe(false);
  });

  it("preserves authoritative V2 order instead of sorting reconstructed collections", () => {
    const rows = [
      projected(userMessage("2026-06-20T00:00:03.000Z"), 0),
      projected(command("2026-06-20T00:00:01.000Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 2),
    ];

    const feed = buildThreadFeed(rows);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual([
      "message-user",
      "local:thread-1:item-command",
      "message-assistant",
    ]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.projectedItem).toBe(rows[1]);
    expect(activity?.getFullDetail()).toContain('"input": "vp check"');
  });

  it("keeps adjacent work from different V2 attempts in separate groups", () => {
    const firstRootNodeId = NodeId.make("node-attempt-1");
    const secondRootNodeId = NodeId.make("node-attempt-2");
    const firstCommand = { ...command(), nodeId: firstRootNodeId };
    const secondCommand = {
      ...command("2026-06-20T00:00:03.000Z"),
      id: TurnItemId.make("item-command-retry"),
      ordinal: 2,
      nodeId: secondRootNodeId,
    };
    const attempts = [
      {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: firstRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "initial",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
      },
      {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: secondRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "retry",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:03.000Z"),
      },
    ] satisfies ReadonlyArray<OrchestrationV2RunAttempt>;

    const feed = buildThreadFeed([projected(firstCommand, 0), projected(secondCommand, 1)], {
      attempts,
    });

    expect(feed).toHaveLength(2);
    expect(
      feed.map((entry) =>
        entry.type === "activity-group" ? entry.activities[0]?.attemptId : null,
      ),
    ).toEqual(["attempt-1", "attempt-2"]);
  });

  it("retains inherited and synthetic rows with their original projected identity", () => {
    const inherited = projected(command(), 0, "inherited");
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:03.000Z",
      2,
    );
    const synthetic = projected(
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId: sourceThreadId, runId },
        targetThreadId: threadId,
      },
      1,
      "synthetic",
    );

    const feed = buildThreadFeed([inherited, synthetic]);
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem)).toEqual([inherited, synthetic]);
    expect(activities.map((activity) => activity.projectedItem.visibility)).toEqual([
      "inherited",
      "synthetic",
    ]);
    expect(activities.at(-1)?.prominent).toBe(true);
  });

  it("keeps orchestration relationship cards visible when a completed run is folded", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.500Z",
      2,
    );
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(
        {
          ...forkBase,
          type: "fork",
          source: { type: "run", threadId, runId },
          targetThreadId: sourceThreadId,
        },
        2,
      ),
      projected(assistantMessage(), 3),
    ]);

    const collapsed = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: "2026-06-20T00:00:03.000Z",
      },
      new Set(),
    );

    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.type === "fork"),
      ),
    ).toBe(true);
    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some(
            (activity) => activity.projectedItem.item.type === "command_execution",
          ),
      ),
    ).toBe(false);
  });

  it("folds settled V2 run work while keeping the terminal assistant message visible", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(assistantMessage(), 2),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "work-toggle",
      "message",
    ]);
  });

  it("keeps an active run expanded and detects failures from completed command output", () => {
    const failedCommand: OrchestrationV2TurnItem = {
      ...command(),
      output: "sh: missing-command: command not found",
    };
    const feed = buildThreadFeed([projected(userMessage(), 0), projected(failedCommand, 1)]);
    const presented = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      },
      new Set(),
    );

    expect(presented.some((entry) => entry.type === "run-fold")).toBe(false);
    expect(presented.find((entry) => entry.type === "work-toggle")).toMatchObject({
      summary: "Ran 1 command",
      hiddenCount: 1,
      hasFailure: true,
      live: false,
    });
  });

  it("does not append synthetic timeline work without a projected item", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt);

    expect(presented).toEqual([]);
  });

  it("keeps expanded work in one group with stable row identities", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      runId: null,
      attemptId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      logo: null,
      toolLike: true,
      prominent: false,
      status,
      lifecycleStatus: status === "neutral" ? "inProgress" : "completed",
      workEntry: {
        id,
        createdAt,
        label: `Tool ${id}`,
        tone: "tool",
        command: "vp check",
        itemType: "command_execution",
        toolLifecycleStatus: status === "neutral" ? "inProgress" : "completed",
      },
      projectedItem: projected(command(createdAt), 0),
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        runId: null,
        activities: [
          activity("activity-neutral", "2026-04-01T00:00:01.000Z", "neutral"),
          activity("activity-1", "2026-04-01T00:00:02.000Z"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["work-toggle:work-group:activity-neutral"]);
    expect(collapsed[0]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group:activity-neutral",
      hiddenCount: 3,
      expanded: false,
      summary: "Ran 3 commands",
    });

    const expanded = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(["work-group:activity-neutral"]),
    );
    expect(expanded.map((entry) => entry.id)).toEqual([
      "work-toggle:work-group:activity-neutral",
      "work-details:work-group:activity-neutral",
    ]);
    expect(expanded[0]).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
    expect(expanded[1]).toMatchObject({
      type: "activity-group",
      activities: [
        { id: "activity-1", groupedToolDetail: true, live: false },
        { id: "activity-2", groupedToolDetail: true, live: false },
        { id: "activity-3", groupedToolDetail: true, live: false },
      ],
    });
    const unchanged = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(["work-group:activity-1", "unrelated-group"]),
    );
    expect(unchanged[0]).toBe(expanded[0]);
    expect(unchanged[1]).toBe(expanded[1]);
    expect(deriveThreadFeedPresentation(feed, null, new Set())).toEqual(collapsed);
  });

  it("pretty prints T3 MCP dynamic tool activities and attaches the product logo", () => {
    const toolItem: OrchestrationV2TurnItem = {
      ...base("item-t3-tool", "2026-06-20T00:00:04.000Z", 3),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };

    const feed = buildThreadFeed([projected(toolItem, 0)]);
    const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;

    expect(activity?.summary).toBe("Read a T3 thread");
    expect(activity?.logo).toBe("t3-code");
    expect(activity?.getCopyText().split("\n")[0]).toBe("Read a T3 thread");
  });

  it("uses canonical T3 orchestration summaries in compact work groups", () => {
    const rows = [
      projected(command("2026-06-20T00:00:01.000Z"), 0),
      ...["mcp__t3-code__t3_thread_send", "t3_code.t3_thread_send", "t3_thread_send"].map(
        (toolName, index) =>
          projected(
            {
              ...base(`item-send-${index}`, `2026-06-20T00:00:0${index + 2}.000Z`, index + 2),
              type: "dynamic_tool" as const,
              toolName,
              input: { threadId: `thread-${index}`, message: "Continue" },
              output: { threadId: `thread-${index}`, messageId: `message-${index}` },
            },
            index + 1,
          ),
      ),
      projected(
        {
          ...command("2026-06-20T00:00:06.000Z"),
          id: TurnItemId.make("item-command-2"),
          ordinal: 6,
        },
        4,
      ),
    ];

    const presented = deriveThreadFeedPresentation(
      buildThreadFeed(rows),
      { runId, status: "running", startedAt: null, completedAt: null },
      new Set(),
    );

    expect(presented).toMatchObject([
      {
        type: "work-toggle",
        summary: "Ran 2 commands and sent messages to 3 threads",
        hiddenCount: 5,
        hasFailure: false,
      },
    ]);
  });
});

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;

describe("pending user input answers", () => {
  it("replaces single-select options and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionLabels: ["Go"] },
        "Node.js",
      ),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Node.js"] });

    const orders = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Orders");
    const ordersAndListings = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      orders,
      "Listings",
    );
    expect(ordersAndListings).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Orders", "Listings"],
    });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, ordersAndListings, "Orders"),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Listings"] });

    const paddedOrders = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "  Orders  ",
    );
    expect(paddedOrders).toEqual({ customAnswer: "", selectedOptionLabels: ["Orders"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, paddedOrders, "  Orders  "),
    ).toEqual({ customAnswer: "" });
  });

  it("builds array answers for multi-select questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        runtime: { selectedOptionLabels: ["Go"] },
        scope: { selectedOptionLabels: ["Orders", "Listings"] },
      }),
    ).toEqual({
      runtime: "Go",
      scope: ["Orders", "Listings"],
    });
  });

  it("clears selected options while a custom answer is active", () => {
    expect(
      setPendingUserInputCustomAnswer(
        { selectedOptionLabels: ["Orders", "Listings"] },
        "Orders first",
      ),
    ).toEqual({ customAnswer: "Orders first" });
  });

  it("matches selected chips against normalized option labels", () => {
    expect(
      isPendingUserInputOptionSelected({ selectedOptionLabels: ["Orders"] }, "  Orders  "),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        { selectedOptionLabels: ["Orders"], customAnswer: "Orders first" },
        "  Orders  ",
      ),
    ).toBe(false);
  });
});
