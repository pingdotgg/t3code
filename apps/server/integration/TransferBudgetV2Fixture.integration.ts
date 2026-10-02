import {
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
export function threadCreated(provider: ProviderDriverKind): OrchestrationV2DomainEvent {
  const now = DateTime.makeUnsafe("2026-06-01T00:00:00Z");
  return {
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId: THREAD_ID,
    occurredAt: now,
    payload: {
      id: THREAD_ID,
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
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
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
