import {
  CheckpointId,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
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
export function threadCreated(
  provider: ProviderDriverKind,
  threadId: ThreadId = THREAD_ID,
): OrchestrationV2DomainEvent {
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
        text:
          role === "user"
            ? `Inspect transfer ${index}`
            : `Completed ${provider} inspection ${index}. ` +
              "The projection preserves transcript text and bounds tool output. ".repeat(60),
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
    const base = {
      id: TurnItemId.make(`item-${index}-${tool}`),
      threadId: THREAD_ID,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: tool + 1,
      status: "completed" as const,
      title: mcp ? "MCP search" : `Inspect source ${tool}`,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
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
    const runId = RunId.make(`long-turn-run-${index}`);
    const nodeId = NodeId.make(`long-turn-node-${index}`);
    const common = {
      threadId,
      runId,
      nodeId,
      driver: provider,
      providerInstanceId,
      occurredAt: now,
    };
    const run = {
      id: runId,
      threadId,
      ordinal: index + 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`long-turn-user-${index}`),
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
      return {
        id: TurnItemId.make(`long-turn-item-${index}-${row}`),
        threadId,
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
      };
    };
    const events: OrchestrationV2DomainEvent[] = [
      { ...common, id: EventId.make(`long-turn-run-${index}`), type: "run.created", payload: run },
    ];
    const message = (role: "user" | "assistant", row: string, messageText: string) => {
      const messageId = MessageId.make(`long-turn-${role}-${index}-${row}`);
      const createdBy = role === "user" ? ("user" as const) : ("agent" as const);
      events.push(
        {
          ...common,
          id: EventId.make(`long-turn-message-${index}-${row}`),
          type: "message.updated",
          payload: {
            id: messageId,
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
                  messageId,
                  inputIntent: "turn_start",
                  text: messageText,
                  attachments: [],
                }
              : {
                  ...base(row, null),
                  type: "assistant_message",
                  messageId,
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
        case 5:
          return {
            ...base(String(row), null),
            type: "assistant_message",
            messageId: MessageId.make(`long-turn-progress-${index}-${row}`),
            text: text(index, row, 600),
            streaming: false,
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
