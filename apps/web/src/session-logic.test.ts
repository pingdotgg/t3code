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
  type OrchestrationV2ConversationMessage,
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
  type TimelineEntry,
  workLogEntryIsVisible,
} from "./session-logic";
import { makeThreadProjectionFixture } from "./test-fixtures";
import type { ChatMessage } from "./types";

describe("V2 session presentation", () => {
  it("renders provider-hydrated messages that do not have turn-item identities", () => {
    const threadId = ThreadId.make("thread-hermes-imported-history");
    const userAt = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");
    const assistantAt = DateTime.makeUnsafe("2026-07-25T12:00:01.000Z");
    const userMessageId = MessageId.make("message-hermes-history-user");
    const assistantMessageId = MessageId.make("message-hermes-history-assistant");
    const attachmentId = "thread-hermes-imported-history-00000000-0000-0000-0000-000000000001";
    const projectionMessages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
      {
        id: userMessageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Existing question",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "img_fixture.webp",
            mimeType: "image/webp",
            sizeBytes: 12,
          },
        ],
        streaming: false,
        createdBy: "user",
        creationSource: "provider",
        createdAt: userAt,
        updatedAt: userAt,
      },
      {
        id: assistantMessageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: "Existing answer",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: assistantAt,
        updatedAt: assistantAt,
      },
    ];
    const assistantItem = {
      id: TurnItemId.make("item-hermes-history-assistant"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: assistantAt,
      completedAt: assistantAt,
      updatedAt: assistantAt,
      type: "assistant_message" as const,
      messageId: assistantMessageId,
      text: "Existing answer",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: assistantItem.id,
        item: assistantItem,
      },
    ];

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      projectionMessages,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachmentId, "/assets/imported-image"]]),
    });

    expect(
      entries.flatMap((entry) =>
        entry.kind === "message" ? [[entry.message.role, entry.message.text]] : [],
      ),
    ).toEqual([
      ["user", "Existing question"],
      ["assistant", "Existing answer"],
    ]);
    expect(
      entries.find((entry) => entry.kind === "message" && entry.message.id === userMessageId),
    ).toMatchObject({
      message: {
        attachments: [
          {
            id: attachmentId,
            previewUrl: "/assets/imported-image",
          },
        ],
      },
    });
  });

  it("skips provider-hydrated orphan rows whose text is already committed", () => {
    const threadId = ThreadId.make("thread-hermes-dedup");
    const at = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");
    const committedMessageId = MessageId.make("message-web-user");
    const makeProjectionMessage = (
      id: string,
      text: string,
      createdAt: DateTime.Utc = at,
    ): OrchestrationV2ConversationMessage => ({
      id: MessageId.make(id),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "provider",
      createdAt,
      updatedAt: createdAt,
    });
    const userItem = {
      id: TurnItemId.make("item-web-user"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "user_message" as const,
      messageId: committedMessageId,
      text: "make me a script",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
      inputIntent: "turn_start" as const,
    } satisfies OrchestrationV2TurnItem;

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: userItem.id,
          item: userItem,
        },
      ],
      projectionMessages: [
        // Hydrated duplicate of the committed web message: skipped.
        makeProjectionMessage("message:provider:hermes:native-item:abc123", "make me a script"),
        // Distinct hydrated history: kept.
        makeProjectionMessage("message:provider:hermes:native-item:def456", "another question"),
        // Imported history reusing the same text once the committed
        // occurrence budget is spent: kept.
        makeProjectionMessage(
          "message:provider:hermes:native-item:old789",
          "make me a script",
          DateTime.makeUnsafe("2026-07-20T12:00:00.000Z"),
        ),
        // Non-hydrated orphan rows are never text-deduped: kept.
        makeProjectionMessage("message-app-created", "another question"),
      ],
      optimisticMessages: [],
    });

    expect(
      entries.flatMap((entry) => (entry.kind === "message" ? [entry.message.text] : [])),
    ).toEqual(["make me a script", "make me a script", "another question", "another question"]);
  });

  it("merges attachment-bearing hydrated echoes onto their committed entry", () => {
    const threadId = ThreadId.make("thread-hermes-echo-attach");
    const at = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");
    const committedMessageId = MessageId.make("message-web-user-attach");
    const attachmentId = "thread-hermes-echo-attach-00000000-0000-0000-0000-000000000001";
    const userItem = {
      id: TurnItemId.make("item-web-user-attach"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "user_message" as const,
      messageId: committedMessageId,
      text: "look at this",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
      inputIntent: "turn_start" as const,
    } satisfies OrchestrationV2TurnItem;

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: userItem.id,
          item: userItem,
        },
      ],
      projectionMessages: [
        {
          id: MessageId.make("message:provider:hermes:native-item:echo1"),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: "look at this",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
          streaming: false,
          createdBy: "user",
          creationSource: "provider",
          createdAt: at,
          updatedAt: at,
        },
      ],
      attachmentUrlById: new Map([[attachmentId, "blob:photo"]]),
      optimisticMessages: [],
    });

    const messages = entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(committedMessageId);
    expect(messages[0]?.attachments).toEqual([
      {
        type: "image",
        id: attachmentId,
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 4,
        previewUrl: "blob:photo",
      },
    ]);
  });

  it("merges durable attachments into committed assistant turn items", () => {
    const threadId = ThreadId.make("thread-hermes-media");
    const at = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");
    const assistantMessageId = MessageId.make("message-hermes-media-assistant");
    const attachmentId = "thread-hermes-media-00000000-0000-0000-0000-000000000002";
    const projectionMessages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
      {
        id: assistantMessageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: "",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "generated.png",
            mimeType: "image/png",
            sizeBytes: 34,
          },
        ],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: at,
      },
    ];
    const assistantItem = {
      id: TurnItemId.make("item-hermes-media-assistant"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "assistant_message" as const,
      messageId: assistantMessageId,
      text: "",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: assistantItem.id,
          item: assistantItem,
        },
      ],
      projectionMessages,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachmentId, "/assets/generated-image"]]),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "message",
      message: {
        id: assistantMessageId,
        role: "assistant",
        attachments: [
          {
            id: attachmentId,
            previewUrl: "/assets/generated-image",
          },
        ],
      },
    });
  });

  it("keeps projected V2 tool calls visible throughout their lifecycle", () => {
    const now = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");
    const threadId = ThreadId.make("thread-hermes-tools");
    const statuses = ["running", "completed", "failed"] as const;
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = statuses.map(
      (status, position) => {
        const item = {
          id: TurnItemId.make(`tool-${status}`),
          threadId,
          runId: RunId.make("run-hermes-tools"),
          nodeId: NodeId.make(`node-${status}`),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: position,
          status,
          title: null,
          startedAt: now,
          completedAt: status === "running" ? null : now,
          updatedAt: now,
          type: "dynamic_tool" as const,
          toolName: "browser.search",
          input: { query: status },
          ...(status === "running" ? {} : { output: { status } }),
        } satisfies OrchestrationV2TurnItem;
        return {
          position,
          visibility: "local" as const,
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        };
      },
    );

    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
    });
    const workEntries = entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));

    expect(workEntries.map((entry) => entry.toolLifecycleStatus)).toEqual([
      "inProgress",
      "completed",
      "failed",
    ]);
    expect(workEntries.every(workLogEntryIsVisible)).toBe(true);
    expect(workEntries.map((entry) => entry.toolData)).toEqual([
      { input: { query: "running" }, output: undefined },
      { input: { query: "completed" }, output: { status: "completed" } },
      { input: { query: "failed" }, output: { status: "failed" } },
    ]);

    expect(
      workLogEntryIsVisible({
        id: "legacy-placeholder",
        createdAt: "2026-07-25T12:00:00.000Z",
        label: "Tool call",
        tone: "tool",
        toolLifecycleStatus: "inProgress",
      }),
    ).toBe(false);
  });

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

  it("uses visible turn item order and keeps lifecycle resource entries standalone", () => {
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
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      userItem,
      requestItem,
      commandItem,
      resultItem,
      todoItem,
      errorItem,
      threadCreatedItem,
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
      ["event", errorItem.id],
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
    expect(errorEntry?.kind).toBe("event");
    if (errorEntry?.kind === "event") {
      expect(errorEntry.projectedItem).toBe(visibleTurnItems[5]);
      expect(errorEntry.projectedItem.item.type).toBe("error");
      if (errorEntry.projectedItem.item.type === "error") {
        expect(errorEntry.projectedItem.item.failure.message).toBe("Invalid reasoning effort.");
      }
    }
    const threadCreatedEntry = entries[6];
    expect(threadCreatedEntry?.kind).toBe("event");
    if (threadCreatedEntry?.kind === "event") {
      expect(threadCreatedEntry.projectedItem.item.type).toBe("thread_created");
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
