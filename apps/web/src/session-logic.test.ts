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
import { resolveWorkEntryToolPresentation } from "@t3tools/client-runtime/work-log/presentation";

import {
  deriveTimelineEntriesFromVisibleTurnItems,
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

describe("deriveWorkLogEntries quiet-timeline guarantee", () => {
  it("N concurrent subagents produce exactly N lifecycle rows, zero attributed tool rows", () => {
    const activities: OrchestrationThreadActivity[] = [];
    for (let agent = 0; agent < 5; agent += 1) {
      const taskId = `task-${agent}`;
      // Progress ticks (several per agent) + attributed tool rows.
      for (let tick = 0; tick < 4; tick += 1) {
        activities.push(
          makeActivity({
            kind: "task.progress",
            summary: `agent ${agent} tick ${tick}`,
            tone: "info",
            payload: { taskId, summary: `working ${tick}`, role: "explorer" },
            turnId: "turn-batch",
            sequence: agent * 20 + tick,
          }),
        );
        activities.push(
          makeActivity({
            kind: "tool.completed",
            summary: "Read",
            payload: { itemType: "dynamic_tool_call", agentId: taskId },
            sequence: agent * 20 + 10 + tick,
          }),
        );
      }
      activities.push(
        makeActivity({
          kind: "task.completed",
          summary: "Task completed",
          tone: "info",
          payload: {
            taskId,
            status: "completed",
            summary: `agent ${agent} done`,
            role: "explorer",
          },
          turnId: "turn-batch",
          sequence: agent * 20 + 19,
        }),
      );
    }

    const entries = deriveWorkLogEntries(activities);
    // A1 CTA design: all direct spawns in one turn collapse into ONE
    // call-to-action row carrying the batch's agent ids.
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]!.agentSpawn!.agentTaskIds).toHaveLength(5);
    expect(spawnRows[0]!.agentSpawn!.workflowId).toBeNull();
    // No agent-attributed tool rows leak into the main log.
    expect(entries.some((entry) => entry.sourceActivityKind?.startsWith("tool."))).toBe(false);
  });

  it("a workflow run and its members collapse into one CTA row keyed to the coordinator", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "coordinator",
        tone: "info",
        payload: { taskId: "wf-1", taskType: "local_workflow", workflowName: "math-check" },
        sequence: 1,
      }),
      makeActivity({
        kind: "task.progress",
        summary: "member",
        tone: "info",
        payload: { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" },
        sequence: 2,
      }),
      makeActivity({
        kind: "task.completed",
        summary: "member done",
        tone: "info",
        payload: { taskId: "wf-1:wf:1", status: "completed", parentAgentId: "wf-1" },
        sequence: 3,
      }),
    ]);
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]!.agentSpawn!.workflowId).toBe("wf-1");
    expect(spawnRows[0]!.agentSpawn!.agentTaskIds).toEqual(
      expect.arrayContaining(["wf-1", "wf-1:wf:0", "wf-1:wf:1"]),
    );
  });

  it("keeps unattributed tool rows (over-hiding loses the only signal)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "tool.completed",
        summary: "Bash",
        payload: { itemType: "command_execution", command: "ls" },
      }),
    ]);
    expect(entries).toHaveLength(1);
  });

  it("folds timelineBypass agent rows into one CTA (Codex children, workflow members)", () => {
    // Codex children carry their parent's spawn turn (spawnTurnId stamping),
    // which is what batches a fleet into one CTA.
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "child work",
        tone: "info",
        payload: { taskId: "child-1", timelineBypass: true },
        turnId: "turn-spawn",
      }),
      makeActivity({
        kind: "task.progress",
        summary: "child work again",
        tone: "info",
        payload: { taskId: "child-2", timelineBypass: true },
        turnId: "turn-spawn",
      }),
    ]);
    // Not suppressed outright (a Codex fleet's rows are ALL bypassed and
    // still need a CTA anchor) — but never more than the batch's single row.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentSpawn?.agentTaskIds).toEqual(["child-1", "child-2"]);
  });

  it("timelineBypass non-agent rows (background shells) stay suppressed", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "stall",
        tone: "info",
        payload: { taskId: "sh-1", taskType: "local_bash", timelineBypass: true },
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("drops task.updated and tool.progress from the work log (fold input only)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.updated",
        summary: "Task running",
        tone: "info",
        payload: { taskId: "task-1", status: "running" },
      }),
      makeActivity({
        kind: "tool.progress",
        summary: "Read",
        tone: "info",
        payload: { taskId: "task-1", toolName: "Read" },
      }),
    ]);
    expect(entries).toHaveLength(0);
  });
});

describe("rerun workflows", () => {
  it("turn-less direct spawns do not collapse into one global batch", () => {
    // Rows that lost their turn id (defensive path) group per task, so two
    // unrelated turn-less spawns never merge into one immortal CTA.
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "loose-1", taskType: "local_agent", role: "a" },
        sequence: 1,
      }),
      makeActivity({
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "loose-2", taskType: "local_agent", role: "b" },
        sequence: 2,
      }),
    ]);
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(2);
    expect(spawnRows.map((row) => row.agentSpawn!.agentTaskIds)).toEqual([
      ["loose-1"],
      ["loose-2"],
    ]);
  });

  it("each workflow run gets its own CTA row (distinct coordinator ids)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "run 1",
        tone: "info",
        payload: { taskId: "wf-run1", taskType: "local_workflow", workflowName: "math-check" },
        turnId: "turn-1",
        sequence: 1,
      }),
      makeActivity({
        kind: "task.completed",
        summary: "run 1 done",
        tone: "info",
        payload: { taskId: "wf-run1", status: "completed", taskType: "local_workflow" },
        turnId: "turn-1",
        sequence: 2,
      }),
      makeActivity({
        kind: "task.progress",
        summary: "run 2",
        tone: "info",
        payload: { taskId: "wf-run2", taskType: "local_workflow", workflowName: "math-check" },
        turnId: "turn-2",
        sequence: 3,
      }),
    ]);
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows.map((row) => row.agentSpawn!.workflowId)).toEqual(["wf-run1", "wf-run2"]);
    expect(spawnRows.map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises Codex, Claude, OpenCode, and Cursor as available providers", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "opencode", label: "OpenCode", available: true },
      { value: "cursor", label: "Cursor", available: true },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: true,
    });
  });
});
