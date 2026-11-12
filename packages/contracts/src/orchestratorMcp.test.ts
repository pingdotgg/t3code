import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadBroadcastInput,
  OrchestratorMcpThreadBroadcastResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeBroadcastInput = Schema.decodeUnknownSync(OrchestratorMcpThreadBroadcastInput);
const decodeBroadcastResult = Schema.decodeUnknownSync(OrchestratorMcpThreadBroadcastResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });

  it("decodes broadcast fan-out requests and delivery results", () => {
    const request = decodeBroadcastInput({
      message: "Ship notes to the team.",
      threadIds: ["thread-a", "thread-b"],
      mode: "queue",
      roomThreadId: "thread-room",
      clientRequestId: "broadcast-1",
    });
    expect(request.threadIds).toEqual(["thread-a", "thread-b"]);
    expect(request.roomThreadId).toBe("thread-room");
    expect(
      decodeBroadcastResult({
        projectId: "project-1",
        deliveries: [
          {
            threadId: "thread-a",
            messageId: "message-a",
            runId: "run-a",
            status: "queued",
            delivery: "queued",
          },
        ],
        skipped: [{ threadId: "thread-b", reason: "self" }],
        room: {
          threadId: "thread-room",
          messageId: "message-room",
          runId: "run-room",
          status: "queued",
          delivery: "queued",
        },
      }).deliveries,
    ).toHaveLength(1);
  });
});
