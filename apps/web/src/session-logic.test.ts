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

  it("offers Stop while a run is preparing/starting, not just once it's running (#13392)", () => {
    const runtimeWithStatus = (
      status: ThreadRuntimeSummary["status"],
      activeRunId: RunId | null = null,
    ): ThreadRuntimeSummary => ({
      status,
      activeRunId,
      providerInstanceId: ProviderInstanceId.make("claude-default"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-09-29T00:00:00.000Z",
    });
    const runId = RunId.make("run-stop-while-starting");

    for (const status of ["preparing", "starting", "running"] as const) {
      const runtime = runtimeWithStatus(status, runId);
      expect(deriveCanInterruptRunningThread(true, runtime)).toBe(true);
    }

    expect(deriveCanInterruptRunningThread(false, runtimeWithStatus("running", runId))).toBe(false);

    expect(derivePhase(runtimeWithStatus("queued"))).toBe("connecting");
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("queued"))).toBe(false);
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("queued", runId))).toBe(true);

    expect(derivePhase(runtimeWithStatus("waiting"))).toBe("running");
    expect(deriveCanInterruptRunningThread(true, runtimeWithStatus("waiting"))).toBe(true);

    expect(deriveCanInterruptRunningThread(true, null)).toBe(false);
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

    expect(
      providerErrorPresentation({
        ...retryItem,
        status: "failed",
        failure: { ...retryItem.failure, class: "usage_limit" },
      }),
    ).toMatchObject({ label: "Usage limit reached after 2/10 retries" });
    const recoveredLimit = {
      ...retryItem,
      status: "completed" as const,
      completedAt: now,
      failure: { ...retryItem.failure, class: "usage_limit" as const },
    };
    const [recoveredEntry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          item: recoveredLimit,
          position: 0,
          visibility: "local",
          sourceThreadId: recoveredLimit.threadId,
          sourceItemId: recoveredLimit.id,
        },
      ],
      optimisticMessages: [],
    });
    if (recoveredEntry?.kind !== "work") throw new Error("Expected recovered provider work");
    expect(recoveredEntry.entry.label).toBe("Provider recovered (2/10 retries)");
    expect(recoveredEntry.entry.sourceActivityKind).not.toBe("runtime.warning");
    expect(workEntryDisplayIndicatesToolFailure(recoveredEntry.entry)).toBe(false);
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
      threadStartCheckpointReady: true,
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
      explanation: "Show task updates where the agent wrote them",
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
      ["work", threadCreatedItem.id],
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
      expect(commandEntry.entry.command).toBe(commandItem.input);
      expect(commandEntry.entry.detail).toBeUndefined();
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
    expect(threadCreatedEntry?.kind).toBe("work");
    if (threadCreatedEntry?.kind === "work") {
      expect(threadCreatedEntry.entry.projectedItem?.item.type).toBe("thread_created");
    }
    expect(
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [
          {
            ...visibleTurnItems.at(-1)!,
            item: {
              ...workspacePreparationItem,
              deferredWork: { cursor: "work-page", itemCount: 100, lastOrdinal: 107 },
            },
          },
        ],
        optimisticMessages: [],
      }).map((entry) => entry.id),
    ).toEqual([workspacePreparationItem.id]);
  });

  it.each(["pending", "running", "completed"] as const)(
    "shows a %s todo update in the timeline where the agent wrote it",
    (stepStatus) => {
      const projection = makeThreadProjectionFixture();
      const now = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
      const runId = RunId.make("run-tasks");
      const nodeId = NodeId.make("node-tasks");
      const planId = PlanId.make("plan-tasks");
      const steps = [{ id: "step-1", text: "Verify the change", status: stepStatus }];
      const item = {
        id: TurnItemId.make("item-tasks"),
        threadId: projection.thread.id,
        runId,
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
        type: "todo_list" as const,
        planId,
        steps,
      } satisfies OrchestrationV2TurnItem;
      const plans = [
        {
          id: planId,
          threadId: projection.thread.id,
          runId,
          nodeId,
          kind: "todo_list" as const,
          status: "active" as const,
          steps,
        },
      ];

      expect(
        deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            {
              position: 0,
              visibility: "local",
              sourceThreadId: projection.thread.id,
              sourceItemId: item.id,
              item,
            },
          ],
          optimisticMessages: [],
          plans,
        }),
      ).toMatchObject([
        {
          kind: "work",
          entry: {
            label: stepStatus === "completed" ? "Tasks 1/1" : "Tasks 0/1 · Verify the change",
          },
        },
      ]);
    },
  );

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
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      scheduledTaskId: ScheduledTaskId.make("task-queued"),
      senderThreadId: ThreadId.make("thread-agent-sender"),
    } satisfies OrchestrationV2TurnItem;
    for (const inputIntent of [
      "queued_turn",
      "turn_start",
      "steer",
      "promoted_queued_to_steer",
    ] as const) {
      expect(
        deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            {
              position: 0,
              visibility: "local",
              sourceThreadId: projection.thread.id,
              sourceItemId: dispatchedItem.id,
              item: { ...dispatchedItem, inputIntent, status: "pending" },
            },
          ],
          optimisticMessages: [],
        }),
      ).toHaveLength(inputIntent === "queued_turn" ? 0 : 1);
    }
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
      expect(promotedEntries[0].message.scheduledTaskId).toBe("task-queued");
      expect(promotedEntries[0].message.senderThreadId).toBe("thread-agent-sender");
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
      expect(entries[1].entry.detail).toBeUndefined();
      expect(entries[1].entry.changedFiles).toEqual([fileItem.fileName]);
    }
  });
});
