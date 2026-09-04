import {
  MessageId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  deriveRevertTurnCountByUserMessageId,
  findLatestProposedPlan,
  isLatestRunSettled,
  providerErrorPresentation,
  type TimelineEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./session-logic";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "./test-fixtures";
import type { ChatMessage } from "./types";

describe("V2 session presentation", () => {
  it("uses run status as the settlement boundary", () => {
    const runId = RunId.make("run-1");
    expect(
      isLatestRunSettled(
        {
          runId,
          status: "completed",
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: "2026-06-20T00:01:00.000Z",
        },
        null,
      ),
    ).toBe(true);
    expect(
      isLatestRunSettled(
        { runId, status: "running", startedAt: null, completedAt: null },
        { status: "running", activeRunId: runId },
      ),
    ).toBe(false);
    expect(
      isLatestRunSettled(
        { runId, status: "queued", startedAt: null, completedAt: null },
        { status: "running", activeRunId: RunId.make("run-active") },
      ),
    ).toBe(false);
  });

  it("labels provider retry progress, delay, recovery, and exhaustion", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const retryItem = {
      id: TurnItemId.make("item-provider-retry"),
      threadId: ThreadId.make("thread-provider-retry"),
      runId: RunId.make("run-provider-retry"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: "Provider retry",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "error" as const,
      failure: {
        class: "provider_error" as const,
        message: "Claude API overloaded.",
        code: "api_error_529",
        retryable: true,
      },
      retry: {
        attempt: 2,
        maxAttempts: 10,
        retryDelayMs: 1_500,
      },
    } satisfies Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

    expect(providerErrorPresentation(retryItem)).toEqual({
      label: "Retrying provider (2/10)",
      detail: "Claude API overloaded. Retrying in 1.5s.",
    });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "completed",
        completedAt: now,
      }),
    ).toMatchObject({ label: "Provider recovered (2/10 retries)" });
    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        retry: { ...retryItem.retry, attempt: 10 },
        completedAt: now,
      }),
    ).toMatchObject({ label: "Provider error after 10/10 retries" });
  });

  it("selects the latest proposed plan for a run", () => {
    const runId = RunId.make("run-1");
    const planId = PlanId.make("plan-1");
    const nodeId = NodeId.make("node-plan");
    const now = DateTime.makeUnsafe("2026-06-20T00:00:01.000Z");
    const baseProjection = makeThreadProjectionFixture();
    const plan = findLatestProposedPlan(
      {
        ...baseProjection,
        plans: [
          {
            id: planId,
            threadId: baseProjection.thread.id,
            nodeId,
            kind: "proposed_plan" as const,
            markdown: "Plan",
            status: "active" as const,
            runId,
          },
        ],
        turnItems: [
          {
            id: TurnItemId.make("item-plan"),
            threadId: baseProjection.thread.id,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "proposed_plan" as const,
            planId,
            markdown: "Plan",
            streaming: false,
            runId,
          },
        ],
        updatedAt: now,
      },
      runId,
    );
    expect(plan?.planMarkdown).toBe("Plan");
  });

  it("assigns run rollback to the turn-start message instead of a later steer", () => {
    const runId = RunId.make("run-steered");
    const turnStartMessageId = MessageId.make("message-turn-start");
    const steerMessageId = MessageId.make("message-steer");
    const assistantMessageId = MessageId.make("message-assistant");
    const messages: ChatMessage[] = [
      {
        id: turnStartMessageId,
        role: "user",
        text: "Start",
        runId,
        inputIntent: "turn_start",
        streaming: false,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
      {
        id: steerMessageId,
        role: "user",
        text: "Steer",
        runId,
        inputIntent: "steer",
        streaming: false,
        createdAt: "2026-06-20T00:00:01.000Z",
        updatedAt: "2026-06-20T00:00:01.000Z",
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "Done",
        runId,
        streaming: false,
        createdAt: "2026-06-20T00:00:02.000Z",
        updatedAt: "2026-06-20T00:00:02.000Z",
      },
    ];
    const timelineEntries: TimelineEntry[] = messages.map((message): TimelineEntry => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    }));

    const targets = deriveRevertTurnCountByUserMessageId({
      timelineEntries,
      checkpoints: [
        {
          runId,
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-run-1" as never,
          status: "ready",
          files: [],
          assistantMessageId,
          completedAt: "2026-06-20T00:00:03.000Z",
        },
      ],
    });

    expect([...targets]).toEqual([[turnStartMessageId, 0]]);
    expect(targets.has(steerMessageId)).toBe(false);
  });

  it("uses visible turn item order and keeps provider errors in the work log", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const threadId = ThreadId.make("thread-visible");
    const runId = RunId.make("run-visible");
    const base = (id: string, ordinal: number) => ({
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
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const userItem = {
      ...base("item-user", 0),
      type: "user_message" as const,
      messageId: MessageId.make("message-user"),
      inputIntent: "turn_start" as const,
      text: "Start",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    } satisfies OrchestrationV2TurnItem;
    const requestItem = {
      ...base("item-interrupt-request", 1),
      type: "run_interrupt_request" as const,
      message: "Stopping",
    } satisfies OrchestrationV2TurnItem;
    const commandItem = {
      ...base("item-command", 2),
      type: "command_execution" as const,
      input: "sleep 1",
      output: "done",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const resultItem = {
      ...base("item-interrupt-result", 3),
      type: "run_interrupt_result" as const,
      message: "Stopped",
    } satisfies OrchestrationV2TurnItem;
    const todoItem = {
      ...base("item-todo", 4),
      type: "todo_list" as const,
      planId: PlanId.make("plan-visible"),
      explanation: "Keep task detail in the Tasks panel",
      steps: [
        { id: "step-1", text: "First", status: "completed" as const },
        { id: "step-2", text: "Second", status: "pending" as const },
      ],
    } satisfies OrchestrationV2TurnItem;
    const errorItem = {
      ...base("item-error", 5),
      status: "failed" as const,
      type: "error" as const,
      failure: {
        class: "validation_error" as const,
        message: "Invalid reasoning effort.",
        code: "invalid_request",
        retryable: false,
      },
    } satisfies OrchestrationV2TurnItem;
    const threadCreatedItem = {
      ...base("item-thread-created", 6),
      type: "thread_created" as const,
      title: "Follow-up thread",
      targetThreadId: ThreadId.make("thread-follow-up"),
      targetRunId: RunId.make("run-follow-up"),
      targetProviderInstanceId: ProviderInstanceId.make("claude-default"),
      targetModel: "claude-sonnet-4-6",
    } satisfies OrchestrationV2TurnItem;
    const workspacePreparationItem = {
      ...base("item-workspace-preparation", 7),
      type: "command_execution" as const,
      title: "Workspace ready",
      input: "Preparing workspace",
      output: "Workspace preparation completed.",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      userItem,
      requestItem,
      commandItem,
      resultItem,
      todoItem,
      errorItem,
      threadCreatedItem,
      workspacePreparationItem,
    ].map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
    });

    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["message", userItem.messageId],
      ["event", requestItem.id],
      ["work", commandItem.id],
      ["event", resultItem.id],
      ["turn-plan", todoItem.id],
      ["work", errorItem.id],
      ["event", threadCreatedItem.id],
    ]);
    const commandEntry = entries[2];
    const userEntry = entries[0];
    expect(userEntry?.kind).toBe("message");
    if (userEntry?.kind === "message") {
      expect(userEntry.projectedItem).toBe(visibleTurnItems[0]);
      expect(userEntry.message.inputIntent).toBe("turn_start");
      expect(userEntry.message.createdBy).toBe("user");
      expect(userEntry.message.creationSource).toBe("web");
    }
    expect(commandEntry?.kind).toBe("work");
    if (commandEntry?.kind === "work") {
      expect(commandEntry.entry.projectedItem).toBe(visibleTurnItems[2]);
      expect(commandEntry.entry.structuredPayload).toBe(commandItem);
    }
    const todoEntry = entries[4];
    expect(todoEntry?.kind).toBe("turn-plan");
    if (todoEntry?.kind === "turn-plan") {
      expect(todoEntry.turnPlan.id).toBe("turn-plan:plan-visible");
      expect(todoEntry.turnPlan.plan.explanation).toBe("Keep task detail in the Tasks panel");
      expect(todoEntry.turnPlan.plan.steps).toEqual([
        { step: "First", status: "completed" },
        { step: "Second", status: "pending" },
      ]);
    }
    const errorEntry = entries[5];
    expect(errorEntry?.kind).toBe("work");
    if (errorEntry?.kind === "work") {
      expect(errorEntry.entry.projectedItem).toBe(visibleTurnItems[5]);
      expect(errorEntry.entry.label).toBe("Provider error");
      expect(errorEntry.entry.detail).toBe("Invalid reasoning effort.");
      expect(errorEntry.entry.tone).toBe("info");
      expect(errorEntry.entry.toolLifecycleStatus).toBe("failed");
    }
    const threadCreatedEntry = entries[6];
    expect(threadCreatedEntry?.kind).toBe("event");
    if (threadCreatedEntry?.kind === "event") {
      expect(threadCreatedEntry.projectedItem.item.type).toBe("thread_created");
    }
  });

  it("keeps failed tool items tool-toned so groups still summarize", () => {
    const failedCommand = {
      id: TurnItemId.make("item-failed-command"),
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "failed" as const,
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.nowUnsafe(),
      type: "command_execution" as const,
      input: "ssh host true",
      output: "connection refused",
      exitCode: 255,
    } satisfies OrchestrationV2TurnItem;
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local" as const,
          sourceThreadId: ThreadId.make("thread-1"),
          sourceItemId: failedCommand.id,
          item: failedCommand,
        } as never,
      ],
      optimisticMessages: [],
    });
    const entry = entries[0];
    expect(entry?.kind).toBe("work");
    if (entry?.kind === "work") {
      // An exit-code failure is still an ordinary tool row: the failed
      // lifecycle status carries the marker, and an "error" tone here would
      // knock the whole group out of the "Ran N commands" summary.
      expect(entry.entry.tone).toBe("tool");
      expect(entry.entry.toolLifecycleStatus).toBe("failed");
    }
  });

  it("waits for a dispatched turn item before adding queued input to the timeline", () => {
    const projection = makeThreadProjectionFixture();
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const runId = RunId.make("run-dispatched-queued");
    const messageId = MessageId.make("message-dispatched-queued");
    const optimisticMessage = {
      id: messageId,
      role: "user" as const,
      text: "Queued input",
      runId: null,
      inputIntent: "queued_turn" as const,
      streaming: false,
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    };

    expect(
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [],
        optimisticMessages: [optimisticMessage],
      }),
    ).toEqual([]);

    const dispatchedItem = {
      id: TurnItemId.make("item-dispatched-queued"),
      threadId: projection.thread.id,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 200,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "user_message" as const,
      messageId,
      inputIntent: "turn_start" as const,
      text: "Queued input",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    } satisfies OrchestrationV2TurnItem;
    const promotedEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: projection.thread.id,
          sourceItemId: dispatchedItem.id,
          item: dispatchedItem,
        },
      ],
      optimisticMessages: [optimisticMessage],
    });
    expect(promotedEntries.map((entry) => entry.id)).toEqual([messageId]);
    expect(promotedEntries[0]?.kind).toBe("message");
    if (promotedEntries[0]?.kind === "message") {
      expect(promotedEntries[0].message.inputIntent).toBe("turn_start");
    }
  });

  it("anchors feedback before later committed turns without reordering canonical history", () => {
    const threadId = ThreadId.make("thread-feedback-order");
    const messageItem = (input: {
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly createdAt: string;
      readonly ordinal: number;
    }): OrchestrationV2TurnItem => {
      const timestamp = DateTime.makeUnsafe(input.createdAt);
      const common = {
        id: TurnItemId.make(`item-${input.id}`),
        threadId,
        runId: RunId.make(`run-${input.ordinal}`),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        status: "completed" as const,
        title: null,
        startedAt: timestamp,
        completedAt: timestamp,
        updatedAt: timestamp,
        messageId: MessageId.make(input.id),
        text: input.id,
      };
      return input.role === "user"
        ? {
            ...common,
            type: "user_message",
            inputIntent: "turn_start",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          }
        : { ...common, type: "assistant_message", streaming: false };
    };
    const canonicalItems = [
      messageItem({ id: "old-user", role: "user", createdAt: "2026-08-29T00:00:01Z", ordinal: 1 }),
      messageItem({
        id: "old-assistant",
        role: "assistant",
        createdAt: "2026-08-29T00:00:02Z",
        ordinal: 2,
      }),
      messageItem({
        id: "later-user",
        role: "user",
        createdAt: "2026-08-29T00:00:05Z",
        ordinal: 3,
      }),
      messageItem({
        id: "later-assistant",
        role: "assistant",
        createdAt: "2026-08-29T00:00:04Z",
        ordinal: 4,
      }),
    ];
    const visibleTurnItems = canonicalItems.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));
    const feedback = (id: string, role: "user" | "assistant"): ChatMessage => ({
      id: MessageId.make(id),
      role,
      text: id,
      runId: null,
      streaming: false,
      createdAt: "2026-08-29T00:00:03Z",
      updatedAt: "2026-08-29T00:00:03Z",
    });
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      anchoredMessages: [
        feedback("feedback-user", "user"),
        feedback("feedback-assistant", "assistant"),
        feedback("later-user", "user"),
      ],
      optimisticMessages: [
        { ...feedback("optimistic-user", "user"), createdAt: "2026-08-29T00:00:00Z" },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      "old-user",
      "old-assistant",
      "feedback-user",
      "feedback-assistant",
      "later-user",
      "later-assistant",
      "optimistic-user",
    ]);
    expect(
      entries
        .filter((entry) => entry.id.startsWith("feedback-"))
        .every((entry) => entry.kind === "message" && entry.projectedItem === undefined),
    ).toBe(true);
  });

  it("uses projected plan status and file contents in timeline entries", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const threadId = ThreadId.make("thread-timeline-artifacts");
    const runId = RunId.make("run-timeline-artifacts");
    const nodeId = NodeId.make("node-timeline-artifacts");
    const planId = PlanId.make("plan-timeline-artifacts");
    const base = {
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const planItem = {
      ...base,
      id: TurnItemId.make("item-proposed-plan"),
      ordinal: 0,
      type: "proposed_plan" as const,
      planId,
      markdown: "Finished plan",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;
    const fileItem = {
      ...base,
      id: TurnItemId.make("item-file-change"),
      ordinal: 1,
      type: "file_change" as const,
      fileName: "src/example.ts",
      newStr: "export const answer = 42;\n",
    } satisfies OrchestrationV2TurnItem;
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      planItem,
      fileItem,
    ].map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
      plans: [
        {
          id: planId,
          threadId,
          runId,
          nodeId,
          kind: "proposed_plan",
          markdown: "",
          status: "completed",
          detailInTurnItem: true,
        },
      ],
    });

    expect(entries[0]?.kind).toBe("proposed-plan");
    if (entries[0]?.kind === "proposed-plan") {
      expect(entries[0].proposedPlan.status).toBe("completed");
      expect(entries[0].proposedPlan.planMarkdown).toBe("Finished plan");
    }
    expect(entries[1]?.kind).toBe("work");
    if (entries[1]?.kind === "work") {
      expect(entries[1].entry.detail).toBe(fileItem.newStr);
    }
  });

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

  it("keeps browser identity and its source on a completed tool row", () => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "browser_snapshot",
      input: {},
      output: {},
      toolSurface: "browser" as const,
      toolIcon: { _tag: "website" as const, pageUrl: "https://example.com/checkout" },
      toolSource: { key: "browser-use:browser", name: "Chrome", kind: "browser" as const },
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({
      kind: "work",
      entry: {
        toolSurface: "browser",
        toolIcon: item.toolIcon,
        toolSource: item.toolSource,
        toolLifecycleStatus: "completed",
      },
    });
  });

  it("shows provider-returned images on an assistant message using the environment asset URL", () => {
    const attachment = {
      type: "image" as const,
      id: "assistant-image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 512,
    };
    const item = {
      ...base,
      type: "assistant_message" as const,
      messageId: MessageId.make("assistant-native-image"),
      text: "Here is the screenshot.",
      streaming: false,
      attachments: [attachment],
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://remote.example/api/assets/screenshot"]]),
    });
    expect(entry).toMatchObject({
      kind: "message",
      message: {
        role: "assistant",
        attachments: [
          { ...attachment, previewUrl: "https://remote.example/api/assets/screenshot" },
        ],
      },
    });
  });

  it("keeps an idle provider task neutral without a completion mark", () => {
    const entry = {
      id: "idle-tool",
      createdAt: DateTime.formatIso(timestamp),
      label: "Waiting for the next task",
      tone: "tool" as const,
      toolLifecycleStatus: "idle" as const,
    };
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
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

  it("does not call a clean completed row failed", () => {
    const entry = toolEntry({ toolLifecycleStatus: "completed", detail: "3 files changed" });
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(true);
  });

  it("recovered failure text no longer counts as success", () => {
    const entry = toolEntry({ toolLifecycleStatus: "completed", detail: "ENOENT: no such file" });
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
  });
});

describe("incremental v2 timeline entries", () => {
  it("retains history and attachment previews through decoded streaming updates", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const attachment = {
      type: "image" as const,
      id: "stream-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message"
        ? { ...row, item: { ...row.item, attachments: [attachment] } }
        : row,
    );
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://server.test/image"]]),
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    Object.freeze(previous.entries);
    for (const entry of previous.entries) Object.freeze(entry);
    const last = visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const nextItem = {
      ...last,
      item: {
        ...last.item,
        text: "Next token",
        attachments: [{ ...attachment }],
        startedAt: DateTime.makeUnsafe(fixture.time(7)),
        updatedAt: DateTime.makeUnsafe(fixture.time(8)),
      },
    };
    const nextInput = {
      ...input,
      visibleTurnItems: [...visibleTurnItems.slice(0, -1), nextItem],
      attachmentUrlById: new Map(input.attachmentUrlById),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.slice(0, -1).entries()) {
      expect(next.entries[index]).toBe(entry);
    }
    const beforeMessage = previous.entries.at(-1)!;
    const nextMessage = next.entries.at(-1)!;
    if (beforeMessage.kind !== "message" || nextMessage.kind !== "message") {
      throw new Error("Expected assistant entries");
    }
    expect(nextMessage.message.attachments).toBe(beforeMessage.message.attachments);
    expect(nextMessage.projectedItem).toBe(nextItem);
    expect(nextMessage.message.text).toBe("Next token");
    expect(beforeMessage.message.text).toBe("Partial");

    const renewedInput = {
      ...nextInput,
      attachmentUrlById: new Map([[attachment.id, "https://renewed.test/image"]]),
    };
    const renewed = deriveTimelineEntriesFromVisibleTurnItemsWithState(renewedInput, next);
    expect(renewed.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(renewedInput));
    expect(renewed.entries.at(-1)).toMatchObject({
      message: { attachments: [{ previewUrl: "https://renewed.test/image" }] },
    });
    expect(nextMessage.message.attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/image",
    });
    const restoredInput = { ...renewedInput, attachmentUrlById: new Map<string, string>() };
    const restored = deriveTimelineEntriesFromVisibleTurnItemsWithState(restoredInput, renewed);
    expect(restored.entries.at(-1)).toMatchObject({ message: { attachments: [attachment] } });
    const restoredMessage = restored.entries.at(-1)!;
    if (restoredMessage.kind !== "message") throw new Error("Expected assistant entry");
    expect(restoredMessage.message.attachments?.[0]).not.toHaveProperty("previewUrl");
  });

  it("appends committed items in canonical order even when their timestamps go backwards", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const last = fixture.visibleTurnItems.at(-1)!;
    const appended = {
      ...last,
      position: last.position + 1,
      sourceItemId: TurnItemId.make("late-item"),
      item: {
        ...last.item,
        id: TurnItemId.make("late-item"),
        messageId: MessageId.make("late-message"),
        startedAt: DateTime.makeUnsafe(fixture.time(0)),
      },
    };
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, appended] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)).toMatchObject({ id: "late-message" });
    for (const [index, entry] of previous.entries.entries())
      expect(next.entries[index]).toBe(entry);
  });

  it.each(["completion", "provenance", "ordering", "attachment", "run"] as const)(
    "rebuilds entries for a %s change instead of retaining stale v2 metadata",
    (change) => {
      const fixture = makeStreamingTimelineFixture("Partial");
      const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
      const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const changed =
        change === "provenance"
          ? { ...last, sourceThreadId: ThreadId.make("inherited-thread") }
          : {
              ...last,
              item:
                change === "completion"
                  ? { ...last.item, streaming: false, status: "completed" as const }
                  : change === "ordering"
                    ? { ...last.item, startedAt: DateTime.makeUnsafe(fixture.time(0)) }
                    : change === "run"
                      ? { ...last.item, runId: fixture.historyRunId }
                      : {
                          ...last.item,
                          attachments: [
                            {
                              type: "image",
                              id: "new-image",
                              name: "new.png",
                              mimeType: "image/png",
                              sizeBytes: 42,
                            },
                          ],
                        },
            };
      const nextInput = {
        ...input,
        visibleTurnItems: [...input.visibleTurnItems.slice(0, -1), changed],
      };
      const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
      expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
      expect(next.entries.at(-1)).not.toBe(previous.entries.at(-1));
    },
  );

  it("updates fallback timestamps when the provider has not supplied a message start time", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? { ...row, item: { ...row.item, startedAt: null } }
        : row,
    );
    const input = { visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = {
      ...input,
      visibleTurnItems: visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? {
              ...row,
              item: {
                ...row.item,
                text: "Next token",
                updatedAt: DateTime.makeUnsafe(fixture.time(8)),
              },
            }
          : row,
      ),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)?.createdAt).toBe(fixture.time(8));
  });

  it("keeps unchanged message previews while tool output rebuilds the work log", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = {
      ...input,
      visibleTurnItems: input.visibleTurnItems.map((row) =>
        row.item.type === "command_execution"
          ? { ...row, item: { ...row.item, output: "Additional output" } }
          : row,
      ),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.entries()) {
      if (entry.kind === "message") expect(next.entries[index]).toBe(entry);
    }
  });

  it("deduplicates optimistic sends when committed items arrive and retains anchored ordering", () => {
    const fixture = makeStreamingTimelineFixture();
    const input = {
      visibleTurnItems: fixture.visibleTurnItems.slice(0, 3),
      optimisticMessages: [
        {
          id: MessageId.make("live-user"),
          runId: null,
          role: "user" as const,
          text: "Continue",
          streaming: false,
          createdAt: fixture.time(5),
          updatedAt: fixture.time(5),
        },
      ],
      anchoredMessages: [
        {
          id: MessageId.make("feedback"),
          runId: null,
          role: "assistant" as const,
          text: "Feedback received",
          streaming: false,
          createdAt: fixture.time(4),
          updatedAt: fixture.time(4),
        },
      ],
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.filter((entry) => entry.id === "live-user")).toHaveLength(1);
    expect(next.entries.map((entry) => entry.id)).toEqual([
      "history-user",
      "history-work",
      "history-assistant",
      "feedback",
      "live-user",
      "live-work",
      "live-assistant",
    ]);
  });
});
