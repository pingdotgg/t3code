import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpThreadListResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeListScheduledTasksResult = Schema.decodeUnknownSync(
  OrchestratorMcpListScheduledTasksResult,
);
const decodeThreadListResult = Schema.decodeUnknownSync(OrchestratorMcpThreadListResult);

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

  it("carries a scheduled task's model selection", () => {
    const task = {
      scheduledTaskId: "scheduled-task-1",
      title: "Nightly report",
      prompt: "Summarize the day.",
      enabled: true,
      projectId: "project-1",
      boundThreadId: null,
      modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
      schedule: { type: "interval", everyMs: 3_600_000 },
      nextRunAt: null,
      lastRunStatus: "never",
    };

    expect(decodeListScheduledTasksResult({ tasks: [task] }).tasks[0]?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("carries a listed thread's branch and worktree path", () => {
    const thread = {
      threadId: "thread-1",
      title: "Thread on a branch",
      createdBy: "user",
      creationSource: "web",
      status: "idle",
      latestRunId: null,
      providerInstanceId: "codex",
      model: "gpt-5.6-luna",
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      branch: "feature/example",
      worktreePath: "/tmp/example",
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      parentThreadId: null,
      relationshipToParent: null,
      itemCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const listed = decodeThreadListResult({
      projectId: "project-1",
      currentThreadId: null,
      threads: [thread],
      nextCursor: null,
      total: 1,
    });
    expect(listed.threads[0]?.branch).toBe("feature/example");
    expect(listed.threads[0]?.worktreePath).toBe("/tmp/example");
  });

  it("decodes results from a server that predates the added fields", () => {
    const thread = {
      threadId: "thread-1",
      title: "Older thread",
      createdBy: "user",
      creationSource: "web",
      status: "idle",
      latestRunId: null,
      providerInstanceId: "codex",
      model: "gpt-5.6-luna",
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      parentThreadId: null,
      relationshipToParent: null,
      itemCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const task = {
      scheduledTaskId: "scheduled-task-1",
      title: "Nightly report",
      prompt: "Summarize the day.",
      enabled: true,
      projectId: "project-1",
      boundThreadId: null,
      schedule: { type: "interval", everyMs: 3_600_000 },
      nextRunAt: null,
      lastRunStatus: "never",
    };

    expect(
      decodeThreadListResult({
        projectId: "project-1",
        currentThreadId: null,
        threads: [thread],
        nextCursor: null,
        total: 1,
      }).threads[0]?.branch,
    ).toBeUndefined();
    expect(
      decodeListScheduledTasksResult({ tasks: [task] }).tasks[0]?.modelSelection,
    ).toBeUndefined();
  });
});
