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
  deriveRevertTurnCountByUserMessageId,
  findLatestProposedPlan,
  isLatestRunSettled,
  providerErrorPresentation,
  type TimelineEntry,
} from "./session-logic";
import { makeThreadProjectionFixture } from "./test-fixtures";
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
    const timelineEntries: TimelineEntry[] = messages.map(
      (message): TimelineEntry => ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }),
    );

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
      ["work", todoItem.id],
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
    expect(todoEntry?.kind).toBe("work");
    if (todoEntry?.kind === "work") {
      expect(todoEntry.entry.label).toBe("Updated tasks");
      expect(todoEntry.entry.detail).toBe("1/2 completed");
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
          markdown: planItem.markdown,
          status: "completed",
        },
      ],
    });

    expect(entries[0]?.kind).toBe("proposed-plan");
    if (entries[0]?.kind === "proposed-plan") {
      expect(entries[0].proposedPlan.status).toBe("completed");
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
  });
});
