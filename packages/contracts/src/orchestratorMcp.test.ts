import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpThreadRun,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);

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
});

it("preserves held, unheld and unknown queue state in run and send JSON", () => {
  for (const queueHeld of [true, false, undefined]) {
    const queue = queueHeld === undefined ? {} : { queueHeld };
    for (const [schema, value] of [
      [
        OrchestratorMcpThreadRun,
        {
          runId: "run-queue",
          ordinal: 1,
          status: "queued",
          providerInstanceId: "codex",
          model: "gpt-6.1-sol",
          requestedAt: "2026-11-02T00:00:00Z",
          startedAt: null,
          completedAt: null,
        },
      ],
      [
        OrchestratorMcpThreadSendResult,
        {
          threadId: "thread-queue",
          messageId: "message-queue",
          runId: "run-queue",
          status: "queued",
          delivery: "queued",
        },
      ],
    ] as const) {
      const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema));
      const encode = Schema.encodeSync(Schema.fromJsonString(schema));
      const decoded = decode(JSON.stringify({ ...value, ...queue }));
      expect(decoded).toEqual({ ...value, ...queue });
      expect(JSON.parse(encode(decoded))).toEqual({ ...value, ...queue });
    }
  }
});
