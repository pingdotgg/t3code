import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type ProviderDriverKind,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  diagnosticOutput,
  TRANSFER_HISTORY_TOOLS_PER_TURN,
  TRANSFER_MEASURED_TOOLS,
  TRANSFER_HISTORY_MCP_RESULT_BYTES,
  TRANSFER_MEASURED_MCP_RESULT_BYTES,
} from "./fixtures/transferBudget.ts";

export const THREAD_ID = ThreadId.make("transfer-budget-thread");
type ThreadCreatedEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>;
export function threadCreated(
  provider: ProviderDriverKind,
  threadId: ThreadId = THREAD_ID,
  overrides: Partial<ThreadCreatedEvent["payload"]> = {},
): ThreadCreatedEvent {
  const now = DateTime.makeUnsafe("2026-06-01T00:00:00Z");
  return {
    id: EventId.make(`thread-created:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("transfer-project"),
      title: "Transfer budget",
      providerInstanceId: ProviderInstanceId.make(provider),
      modelSelection: {
        instanceId: ProviderInstanceId.make(provider),
        model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...overrides,
    },
  };
}
export function turnEvents(
  provider: ProviderDriverKind,
  index: number,
  measured: boolean,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const now = DateTime.makeUnsafe(`2026-06-01T00:${String(index + 1).padStart(2, "0")}:00Z`);
  const runId = RunId.make(`run-${index}`);
  const nodeId = NodeId.make(`node-${index}`);
  const userMessageId = MessageId.make(`user-${index}`);
  const providerInstanceId = ProviderInstanceId.make(provider);
  const run = {
    id: runId,
    threadId: THREAD_ID,
    ordinal: index + 1,
    providerInstanceId,
    modelSelection: {
      instanceId: ProviderInstanceId.make(provider),
      model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
    },
    providerThreadId: null,
    userMessageId,
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const common = {
    threadId: THREAD_ID,
    runId,
    nodeId,
    driver: provider,
    providerInstanceId,
    occurredAt: now,
  };
  const events: OrchestrationV2DomainEvent[] = [
    { ...common, id: EventId.make(`run-${index}`), type: "run.created", payload: run },
  ];
  const answer =
    `Completed ${provider} inspection ${index}. ` +
    "The projection preserves transcript text and bounds tool output. ".repeat(60);
  for (const role of ["user", "assistant"] as const) {
    events.push({
      ...common,
      id: EventId.make(`${role}-${index}`),
      type: "message.updated",
      payload: {
        id: MessageId.make(`${role}-${index}`),
        threadId: THREAD_ID,
        runId,
        nodeId,
        role,
        text: role === "user" ? `Inspect transfer ${index}` : answer,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "web",
      },
    });
  }
  const toolCount = measured ? TRANSFER_MEASURED_TOOLS : TRANSFER_HISTORY_TOOLS_PER_TURN;
  const item = (id: string, ordinal: number, title: string | null) => ({
    id: TurnItemId.make(id),
    threadId: THREAD_ID,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  for (let tool = 0; tool <= toolCount; tool++) {
    const mcp = tool === toolCount;
    const output = diagnosticOutput({
      provider,
      turnIndex: index,
      toolIndex: tool,
      targetBytes: mcp
        ? measured
          ? TRANSFER_MEASURED_MCP_RESULT_BYTES
          : TRANSFER_HISTORY_MCP_RESULT_BYTES
        : 4096,
    });
    const base = item(
      `item-${index}-${tool}`,
      tool + 1,
      mcp ? "MCP search" : `Inspect source ${tool}`,
    );
    events.push({
      ...common,
      id: EventId.make(`tool-${index}-${tool}`),
      type: "turn-item.updated",
      payload: mcp
        ? {
            ...base,
            type: "dynamic_tool",
            toolName: "mcp__test__search",
            input: { query: "transfer" },
            output: { text: output },
          }
        : {
            ...base,
            type: "command_execution",
            input: `cat src/module-${tool}.ts`,
            output,
            exitCode: 0,
          },
    });
  }
  // The live turn repeats its answer in a turn item, as adapters do, so live dedupe has work.
  // History turns skip it to keep the fallback thread snapshot under its wire ceiling.
  if (measured)
    events.push({
      ...common,
      id: EventId.make(`answer-item-${index}`),
      type: "turn-item.updated",
      payload: {
        ...item(`item-${index}-answer`, toolCount + 2, null),
        type: "assistant_message",
        messageId: MessageId.make(`assistant-${index}`),
        text: answer,
        streaming: false,
      },
    });
  events.push({
    ...common,
    id: EventId.make(`complete-${index}`),
    type: "run.updated",
    payload: { ...run, status: "completed", completedAt: now },
  });
  return events;
}

export const LONG_TURN_THREAD_ID = ThreadId.make("transfer-budget-long-turn");
export const LONG_TURN_WORK_ROWS = 900;

/**
 * Three short user turns, then one agent turn far longer than a cold-open
 * window, with the item kinds a long agent run produces. One batch per turn.
 * Run, node, provider and item IDs follow the composite shapes the Claude
 * adapter stores, and every assistant message has its record, as real threads do.
 */
export function longTurnThreadBatches(
  provider: ProviderDriverKind,
): ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>> {
  const threadId = LONG_TURN_THREAD_ID;
  const providerInstanceId = ProviderInstanceId.make(provider);
  const modelSelection = {
    instanceId: providerInstanceId,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
  };
  let ordinal = 0;
  const text = (turn: number, row: number, targetBytes: number) =>
    diagnosticOutput({ provider, turnIndex: 100 + turn, toolIndex: row, targetBytes });

  const turn = (index: number, workRows: number): OrchestrationV2DomainEvent[] => {
    const now = DateTime.makeUnsafe(`2026-06-02T00:${String(index).padStart(2, "0")}:00Z`);
    const runId = RunId.make(`run:thread:${threadId}:ordinal:${index + 1}`);
    const nodeId = NodeId.make(`node:run:${encodeURIComponent(runId)}:root`);
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:provider:${provider}:native-thread:${encodeURIComponent(`pending:${runId}`)}`,
    );
    const providerTurnId = ProviderTurnId.make(
      `provider-turn:provider:${provider}:native-turn:${encodeURIComponent(`turn:run-attempt:${encodeURIComponent(runId)}:attempt:1`)}`,
    );
    const common = {
      threadId,
      runId,
      nodeId,
      driver: provider,
      providerInstanceId,
      occurredAt: now,
    };
    const messageId = (role: "user" | "assistant", row: string) =>
      MessageId.make(
        `message:provider:${provider}:native-item:msg_01LongTurn${role}${index}x${row}`,
      );
    const run = {
      id: runId,
      threadId,
      ordinal: index + 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: messageId("user", "prompt"),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const base = (row: string, title: string | null) => {
      ordinal += 1;
      const nativeId = `toolu_01LongTurn${index}x${row}`;
      return {
        id: TurnItemId.make(`turn-item:provider:${provider}:native-item:${nativeId}`),
        threadId,
        runId,
        nodeId,
        providerThreadId,
        providerTurnId,
        nativeItemRef: { driver: provider, nativeId, strength: "strong" as const },
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
    };
    const events: OrchestrationV2DomainEvent[] = [
      { ...common, id: EventId.make(`long-turn-run-${index}`), type: "run.created", payload: run },
    ];
    const message = (role: "user" | "assistant", row: string, messageText: string) => {
      const id = messageId(role, row);
      const createdBy = role === "user" ? ("user" as const) : ("agent" as const);
      events.push(
        {
          ...common,
          id: EventId.make(`long-turn-message-${index}-${row}`),
          type: "message.updated",
          payload: {
            id,
            threadId,
            runId,
            nodeId,
            role,
            text: messageText,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy,
            creationSource: "web",
          },
        },
        {
          ...common,
          id: EventId.make(`long-turn-item-event-${index}-${row}`),
          type: "turn-item.updated",
          payload:
            role === "user"
              ? {
                  ...base(row, null),
                  type: "user_message",
                  createdBy,
                  creationSource: "web",
                  messageId: id,
                  inputIntent: "turn_start",
                  text: messageText,
                  attachments: [],
                }
              : {
                  ...base(row, null),
                  type: "assistant_message",
                  messageId: id,
                  text: messageText,
                  streaming: false,
                },
        },
      );
    };
    const workItem = (row: number): OrchestrationV2TurnItem => {
      if (row % 100 === 50) {
        return {
          ...base(String(row), "Checkpoint"),
          type: "checkpoint",
          checkpointId: CheckpointId.make(`long-turn-checkpoint-${index}-${row}`),
          scopeId: CheckpointScopeId.make(`long-turn-scope-${index}`),
          files: Array.from({ length: 40 }, (_, file) => ({
            path: `src/feature/module-${row}-${file}.ts`,
            kind: "modified",
            additions: file + 1,
            deletions: file,
          })),
        };
      }
      if (row % 100 === 99) {
        return {
          ...base(String(row), "Subagent"),
          type: "subagent",
          subagentId: NodeId.make(`long-turn-subagent-${index}-${row}`),
          origin: "app_owned",
          driver: provider,
          providerInstanceId,
          childThreadId: null,
          prompt: text(index, row, 2_048),
          result: text(index, row + 1, 3_072),
        };
      }
      switch (row % 8) {
        case 0:
        case 7:
          return {
            ...base(String(row), "Reasoning"),
            type: "reasoning",
            text: text(index, row, 1_536),
            streaming: false,
          };
        case 3:
          return {
            ...base(String(row), `Edit module ${row}`),
            type: "file_change",
            fileName: `src/feature/module-${row}.ts`,
            additions: 12,
            deletions: 4,
            diffStr: text(index, row, 2_048),
          };
        case 4:
          return {
            ...base(String(row), "MCP search"),
            type: "dynamic_tool",
            toolName: "mcp__test__search",
            input: { query: `module ${row}` },
            output: { text: text(index, row, 6_144) },
          };
        default:
          return {
            ...base(String(row), `Run check ${row}`),
            type: "command_execution",
            input: `vp test run src/feature/module-${row}.test.ts`,
            output: text(index, row, 4_096),
            exitCode: 0,
          };
      }
    };

    message("user", "prompt", `Continue the feature work, step ${index}.`);
    for (let row = 0; row < workRows; row++) {
      if (row % 8 === 5) {
        message("assistant", String(row), text(index, row, 1_500));
        continue;
      }
      events.push({
        ...common,
        id: EventId.make(`long-turn-work-${index}-${row}`),
        type: "turn-item.updated",
        payload: workItem(row),
      });
    }
    message("assistant", "answer", text(index, workRows, 1_200));
    events.push({
      ...common,
      id: EventId.make(`long-turn-complete-${index}`),
      type: "run.updated",
      payload: { ...run, status: "completed", completedAt: now },
    });
    return events;
  };

  return [
    [threadCreated(provider, threadId)],
    turn(0, 4),
    turn(1, 4),
    turn(2, 4),
    turn(3, LONG_TURN_WORK_ROWS),
  ];
}

export const STALE_TODO_THREAD_ID = ThreadId.make("transfer-budget-stale-todo-lists");
export const STALE_TODO_SETTLED_RUNS = 40;
export const STALE_TODO_SUBAGENTS_PER_RUN = 2;
export const STALE_TODO_LIVE_ROWS = 600;
const staleTodoCheckpointId = (index: number) =>
  CheckpointId.make(`checkpoint:thread:${STALE_TODO_THREAD_ID}:ordinal:${index + 1}`);
/** The checkpoint clients read the last finished turn's diff from. */
export const STALE_TODO_LAST_FINISHED_CHECKPOINT_ID = staleTodoCheckpointId(
  STALE_TODO_SETTLED_RUNS - 1,
);
const staleTodoRunId = (index: number) =>
  RunId.make(`run:thread:${STALE_TODO_THREAD_ID}:ordinal:${index + 1}`);
export const STALE_TODO_LIVE_RUN_ID = staleTodoRunId(STALE_TODO_SETTLED_RUNS);

/**
 * A long thread: many finished runs, then one run still at work with more rows than a window
 * holds. Every run leaves its todo list node `running` and its plan `active`, as adapters do,
 * and has subagents, a provider turn and (once finished) a checkpoint. One batch per run.
 */
export function staleTodoListThreadBatches(
  provider: ProviderDriverKind,
): ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>> {
  const threadId = STALE_TODO_THREAD_ID;
  const providerInstanceId = ProviderInstanceId.make(provider);
  const modelSelection = {
    instanceId: providerInstanceId,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
  };
  const providerThreadId = ProviderThreadId.make(
    `provider-thread:provider:${provider}:native-thread:stale-todo-lists`,
  );
  const scopeId = CheckpointScopeId.make(`checkpoint-scope:thread:${threadId}:root`);
  let ordinal = 0;
  const text = (run: number, row: number, targetBytes: number) =>
    diagnosticOutput({ provider, turnIndex: 200 + run, toolIndex: row, targetBytes });

  const turn = (index: number, live: boolean): OrchestrationV2DomainEvent[] => {
    const now = DateTime.makeUnsafe(Date.UTC(2026, 5, 4, 0, index));
    const runId = staleTodoRunId(index);
    const runKey = encodeURIComponent(runId);
    const rootNodeId = NodeId.make(`node:run:${runKey}:root`);
    const todoNodeId = NodeId.make(`node:run:${runKey}:todo-list`);
    const planId = PlanId.make(`plan:run:${runKey}:todo-list`);
    const providerTurnId = ProviderTurnId.make(
      `provider-turn:provider:${provider}:native-turn:${encodeURIComponent(`turn:run-attempt:${runKey}:attempt:1`)}`,
    );
    const status = live ? ("running" as const) : ("completed" as const);
    const completedAt = live ? null : now;
    const common = {
      threadId,
      runId,
      nodeId: rootNodeId,
      driver: provider,
      providerInstanceId,
      occurredAt: now,
    };
    const messageId = (role: "user" | "assistant") =>
      MessageId.make(`message:provider:${provider}:native-item:msg_01StaleTodo${role}${index}`);
    const run = {
      id: runId,
      threadId,
      ordinal: index + 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: messageId("user"),
      rootNodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const base = (row: string, title: string | null, nodeId: NodeId = rootNodeId) => {
      ordinal += 1;
      const nativeId = `toolu_01StaleTodo${index}x${row}`;
      return {
        id: TurnItemId.make(`turn-item:provider:${provider}:native-item:${nativeId}`),
        threadId,
        runId,
        nodeId,
        providerThreadId,
        providerTurnId,
        nativeItemRef: { driver: provider, nativeId, strength: "strong" as const },
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
    };
    const events: OrchestrationV2DomainEvent[] = [
      { ...common, id: EventId.make(`stale-todo-run-${index}`), type: "run.created", payload: run },
    ];
    const node = (
      id: NodeId,
      kind: "root_turn" | "todo_list" | "subagent",
      nodeStatus: "running" | "completed",
    ) =>
      events.push({
        ...common,
        id: EventId.make(`stale-todo-node-${id}`),
        type: "node.updated",
        nodeId: id,
        payload: {
          id,
          threadId,
          runId,
          parentNodeId: kind === "root_turn" ? null : rootNodeId,
          rootNodeId,
          kind,
          status: nodeStatus,
          countsForRun: kind === "root_turn",
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: kind === "root_turn" ? scopeId : null,
          startedAt: now,
          completedAt: nodeStatus === "running" ? null : now,
        },
      });
    const message = (role: "user" | "assistant", messageText: string) => {
      const id = messageId(role);
      const createdBy = role === "user" ? ("user" as const) : ("agent" as const);
      events.push(
        {
          ...common,
          id: EventId.make(`stale-todo-message-${index}-${role}`),
          type: "message.updated",
          payload: {
            id,
            threadId,
            runId,
            nodeId: rootNodeId,
            role,
            text: messageText,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy,
            creationSource: "web",
          },
        },
        {
          ...common,
          id: EventId.make(`stale-todo-message-item-${index}-${role}`),
          type: "turn-item.updated",
          payload:
            role === "user"
              ? {
                  ...base(role, null),
                  type: "user_message",
                  createdBy,
                  creationSource: "web",
                  messageId: id,
                  inputIntent: "turn_start",
                  text: messageText,
                  attachments: [],
                }
              : {
                  ...base(role, null),
                  type: "assistant_message",
                  messageId: id,
                  text: messageText,
                  streaming: false,
                },
        },
      );
    };

    if (index === 0)
      events.push({
        ...common,
        id: EventId.make("stale-todo-scope"),
        type: "checkpoint-scope.created",
        payload: {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/workspace/transfer-budget",
          createdAt: now,
        },
      });
    node(rootNodeId, "root_turn", status);
    events.push({
      ...common,
      id: EventId.make(`stale-todo-provider-turn-${index}`),
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: rootNodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: index + 1,
        status,
        startedAt: now,
        completedAt,
      },
    });
    message("user", `Continue the migration, step ${index}.`);

    // The list is done but never closed: the node stays running and the plan stays active.
    const steps = Array.from({ length: 6 }, (_, step) => ({
      id: `step-${step + 1}`,
      text: `Migrate module group ${index}.${step + 1} and run its checks`,
      status: live && step > 2 ? ("pending" as const) : ("completed" as const),
    }));
    node(todoNodeId, "todo_list", "running");
    events.push(
      {
        ...common,
        id: EventId.make(`stale-todo-plan-${index}`),
        type: "plan.updated",
        nodeId: todoNodeId,
        payload: {
          id: planId,
          threadId,
          runId,
          nodeId: todoNodeId,
          status: "active",
          kind: "todo_list",
          steps,
        },
      },
      {
        ...common,
        id: EventId.make(`stale-todo-plan-item-${index}`),
        type: "turn-item.updated",
        nodeId: todoNodeId,
        payload: { ...base("todo", "Todo list", todoNodeId), type: "todo_list", planId, steps },
      },
    );

    for (let subagent = 0; subagent < STALE_TODO_SUBAGENTS_PER_RUN; subagent++) {
      const subagentId = NodeId.make(`node:run:${runKey}:subagent:${subagent + 1}`);
      node(subagentId, "subagent", "completed");
      events.push({
        ...common,
        id: EventId.make(`stale-todo-subagent-${index}-${subagent}`),
        type: "subagent.updated",
        nodeId: subagentId,
        payload: {
          id: subagentId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: provider,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: text(index, subagent * 2, 2_048),
          title: `Review module group ${index}.${subagent + 1}`,
          model: modelSelection.model,
          status: "completed",
          result: text(index, subagent * 2 + 1, 4_096),
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }

    const workRows = live ? STALE_TODO_LIVE_ROWS : 6;
    for (let row = 0; row < workRows; row++)
      events.push({
        ...common,
        id: EventId.make(`stale-todo-work-${index}-${row}`),
        type: "turn-item.updated",
        payload:
          row % 10 === 0
            ? {
                ...base(String(row), "Reasoning"),
                type: "reasoning",
                text: text(index, 10 + row, 1_024),
                streaming: false,
              }
            : {
                ...base(String(row), `Run check ${row}`),
                type: "command_execution",
                input: `vp test run src/migration/module-${index}-${row}.test.ts`,
                output: text(index, 10 + row, 2_048),
                exitCode: 0,
              },
      });
    if (live) return events;

    message("assistant", text(index, 5, 1_200));
    const checkpointId = staleTodoCheckpointId(index);
    events.push(
      {
        ...common,
        id: EventId.make(`stale-todo-checkpoint-${index}`),
        type: "checkpoint.captured",
        payload: {
          id: checkpointId,
          threadId,
          scopeId,
          runId,
          nodeId: rootNodeId,
          parentCheckpointId: index === 0 ? null : staleTodoCheckpointId(index - 1),
          ordinalWithinScope: index + 1,
          appRunOrdinal: index + 1,
          ref: CheckpointRef.make(
            `refs/t3/orchestration-v2/checkpoints/stale-todo-lists/ordinal/${index + 1}`,
          ),
          status: "ready",
          files: Array.from({ length: 12 }, (_, file) => ({
            path: `src/migration/module-${index}-${file}.ts`,
            kind: "modified",
            additions: file + 1,
            deletions: file,
          })),
          capturedAt: now,
        },
      },
      {
        ...common,
        id: EventId.make(`stale-todo-complete-${index}`),
        type: "run.updated",
        payload: { ...run, status: "completed", completedAt: now, checkpointId },
      },
    );
    return events;
  };

  return [
    [threadCreated(provider, threadId)],
    ...Array.from({ length: STALE_TODO_SETTLED_RUNS }, (_, index) => turn(index, false)),
    turn(STALE_TODO_SETTLED_RUNS, true),
  ];
}

export const SHELL_SETTLED_THREADS = 100;
export const SHELL_IDLE_SUBAGENTS = 40;

/**
 * A busy sidebar: settled top-level threads, settled a minute apart, with idle subagent children
 * under the newest ones. Opted-in cold connects skip the children and all but 25 settled threads.
 */
export function shellFleetEvents(
  provider: ProviderDriverKind,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  return Array.from({ length: SHELL_SETTLED_THREADS }, (_, index) => {
    const threadId = ThreadId.make(`transfer-budget-settled-${index}`);
    const settledAt = DateTime.makeUnsafe(Date.UTC(2026, 5, 3, 0, index));
    const settled = threadCreated(provider, threadId, {
      title: `Settled transfer thread ${index}`,
      branch: `feature/settled-${index}`,
      settledOverride: "settled",
      settledAt,
      updatedAt: settledAt,
    });
    if (index < SHELL_SETTLED_THREADS - SHELL_IDLE_SUBAGENTS) return [settled];
    const childId = ThreadId.make(`transfer-budget-settled-${index}-subagent`);
    return [
      settled,
      threadCreated(provider, childId, {
        title: `Subagent of settled thread ${index}`,
        createdBy: "agent",
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      }),
    ];
  }).flat();
}
