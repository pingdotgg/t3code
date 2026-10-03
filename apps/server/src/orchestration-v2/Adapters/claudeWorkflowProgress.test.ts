import { describe, expect, it } from "vite-plus/test";

import {
  mergeClaudeWorkflowProgress,
  parseClaudeWorkflowRunHandles,
} from "./claudeWorkflowProgress.ts";

const startFrame = {
  type: "system",
  subtype: "task_started",
  task_id: "w1",
  task_type: "local_workflow",
  workflow_name: "probe-wf",
};

const snapshotFrame = (
  entries: ReadonlyArray<Record<string, unknown>>,
  usage?: Record<string, number>,
) => ({
  type: "system",
  subtype: "task_progress",
  task_id: "w1",
  description: "Alpha: alpha:one",
  workflow_progress: entries,
  ...(usage === undefined ? {} : { usage }),
});

const phase = (index: number, title: string) => ({ type: "workflow_phase", index, title });

const agent = (overrides: Record<string, unknown>) => ({
  type: "workflow_agent",
  index: 1,
  label: "alpha:one",
  state: "start",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

describe("mergeClaudeWorkflowProgress", () => {
  it("marks a coordinator as a workflow before any member exists", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      name: "probe-wf",
      message: startFrame,
    });
    expect(workflow).toEqual({ name: "probe-wf", phases: [], agents: [] });
  });

  it("leaves an ordinary subagent's frames alone", () => {
    expect(
      mergeClaudeWorkflowProgress({
        previous: undefined,
        message: {
          type: "system",
          subtype: "task_progress",
          task_id: "t1",
          description: "reading files",
          usage: { total_tokens: 500, tool_uses: 2, duration_ms: 90 },
        },
      }),
    ).toBeUndefined();
  });

  it("maps provider agent states and per-member metrics", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        agent({
          state: "done",
          agentId: "a1",
          model: "claude-opus-5[1m]",
          attempt: 2,
          tokens: 71_141,
          toolCalls: 3,
          durationMs: 1277,
          startedAt: 1_700_000_000_000,
          queuedAt: 1_699_999_999_000,
          promptPreview: "Reply with exactly: A1",
          resultPreview: "A1",
        }),
        agent({ index: 2, label: "alpha:two", state: "queued" }),
      ]),
    });
    expect(workflow?.phases).toEqual([{ index: 1, title: "Alpha" }]);
    expect(workflow?.agents[0]).toEqual({
      index: 1,
      label: "alpha:one",
      agentId: "a1",
      state: "completed",
      phaseIndex: 1,
      phaseTitle: "Alpha",
      model: "claude-opus-5[1m]",
      attempt: 2,
      totalTokens: 71_141,
      toolCalls: 3,
      durationMs: 1277,
      queuedAt: 1_699_999_999_000,
      startedAt: 1_700_000_000_000,
      prompt: "Reply with exactly: A1",
      result: "A1",
    });
    expect(workflow?.agents[1]?.state).toBe("queued");
  });

  it("treats an unrecognised state as still running rather than settled", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state: "something-new" })]),
    });
    expect(workflow?.agents[0]?.state).toBe("running");
  });

  it("keeps the roster through a usage-only frame", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      name: "probe-wf",
      message: snapshotFrame([phase(1, "Alpha"), agent({})], {
        total_tokens: 100,
        tool_uses: 1,
        duration_ms: 40,
      }),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([], { total_tokens: 250, tool_uses: 2, duration_ms: 900 }),
    });
    expect(second?.agents).toHaveLength(1);
    expect(second?.phases).toHaveLength(1);
    expect(second?.name).toBe("probe-wf");
    expect(second?.totalTokens).toBe(250);
  });

  it("harvests run handles from the launch acknowledgement", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      runHandles: parseClaudeWorkflowRunHandles({
        status: "async_launched",
        taskType: "local_workflow",
        runId: "wf_abc",
        transcriptDir: "/root/.claude/projects/p/s/subagents/workflows/wf_abc",
        scriptPath: "/root/.claude/projects/p/s/workflows/scripts/x.js",
      }),
      message: startFrame,
    });
    expect(workflow?.runHandles?.transcriptDir).toBe(
      "/root/.claude/projects/p/s/subagents/workflows/wf_abc",
    );
    expect(workflow?.runHandles?.runId).toBe("wf_abc");
  });

  it("ignores a non-workflow tool acknowledgement", () => {
    expect(
      parseClaudeWorkflowRunHandles({ status: "async_launched", taskType: "local_agent" }),
    ).toBeUndefined();
  });

  it("keeps a phase the plan reached at runtime even if a later frame omits it", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([phase(1, "Alpha"), phase(2, "Beta"), phase(3, "Gamma")]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([phase(1, "Alpha")]),
    });
    expect(second?.phases.map((entry) => entry.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("drops malformed entries instead of failing the frame", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        { type: "workflow_phase", title: "No index" },
        { type: "workflow_agent", index: 4 },
        { type: "something_else", index: 1, title: "Ignored" },
        phase(1, "Alpha"),
      ]),
    });
    expect(workflow).toEqual({ phases: [{ index: 1, title: "Alpha" }], agents: [] });
  });
});
