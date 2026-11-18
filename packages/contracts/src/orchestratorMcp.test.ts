import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitResult = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitResult);

describe("orchestrator MCP contracts", () => {
  it("decodes a send's model switch from the record or the array options form", () => {
    const base = { threadId: "thread-1", message: "go", mode: "queue" } as const;
    const fromRecord = decodeThreadSendInput({
      ...base,
      modelSelection: { model: "claude-opus-5-5", options: { effort: "high" } },
    });
    const fromArray = decodeThreadSendInput({
      ...base,
      modelSelection: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
    });
    expect(fromRecord.modelSelection).toEqual({
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(fromArray).toEqual(fromRecord);
    expect(decodeThreadSendInput(base).modelSelection).toBeUndefined();
    expect(() => decodeThreadSendInput({ ...base, modelSelection: {} })).toThrow();
  });

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

  it("decodes a running-task next written by another version", () => {
    const next = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
    expect(
      decodeThreadWaitResult({
        threadId: "thread-child-1",
        runId: "run-child-1",
        status: "running",
        timedOut: true,
        next,
      }).next,
    ).toBe(next);
  });
});
