import { describe, expect, it } from "vite-plus/test";

import { mergeClaudeWorkflowProgress } from "./claudeWorkflowProgress.ts";

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
          lastProgressAt: 1_700_000_004_432,
          queuedAt: 1_699_999_999_000,
          promptPreview: "Reply with exactly: A1",
          resultPreview: "A1",
        }),
        agent({ index: 2, label: "alpha:two", state: "queued", lastProgressAt: 1000 }),
        agent({ index: 3, state: "progress", lastProgressAt: 2000 }),
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
      completedAt: 1_700_000_004_432,
      prompt: "Reply with exactly: A1",
      result: "A1",
    });
    expect(workflow?.agents[1]?.state).toBe("queued");
    expect(workflow?.agents[1]).not.toHaveProperty("completedAt");
    expect(workflow?.agents[2]).not.toHaveProperty("completedAt");
  });

  it.each(["something-new", "toString", "constructor", "__proto__"])(
    "treats unrecognised state %s as still running rather than settled",
    (state) => {
      const workflow = mergeClaudeWorkflowProgress({
        previous: undefined,
        message: snapshotFrame([agent({ state })]),
      });
      expect(workflow?.agents[0]?.state).toBe("running");
    },
  );

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

  it("keeps other members and phase links when a sparse frame starts a new attempt", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        agent({
          state: "error",
          attempt: 1,
          promptPreview: "First prompt",
          resultPreview: "First result",
          tokens: 100,
          toolCalls: 2,
          durationMs: 50,
          queuedAt: 1000,
          startedAt: 1010,
          lastProgressAt: 2010,
        }),
        agent({ index: 2, state: "done" }),
      ]),
    });
    expect(first?.agents[0]?.completedAt).toBe(2010);
    expect(first?.agents[1]).not.toHaveProperty("completedAt");
    const second = mergeClaudeWorkflowProgress({
      previous: first && {
        ...first,
        agents: first.agents.map((member) => ({ ...member, effort: "max", speed: "standard" })),
      },
      message: snapshotFrame([
        { type: "workflow_agent", index: 1, label: "alpha:one", state: "start", attempt: 2 },
      ]),
    });
    expect(second?.agents).toEqual([
      {
        index: 1,
        label: "alpha:one",
        state: "running",
        attempt: 2,
        phaseIndex: 1,
        phaseTitle: "Alpha",
      },
      { ...first?.agents[1], effort: "max", speed: "standard" },
    ]);
    expect(second?.phases).toEqual(first?.phases);
  });

  it("ignores an older attempt after a retry completes", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state: "done", attempt: 2, resultPreview: "New result" })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([agent({ state: "error", attempt: 1, resultPreview: "Old result" })]),
    });
    expect(second?.agents).toEqual(first?.agents);
  });

  it.each([
    ["done", "start"],
    ["done", "queued"],
    ["error", "start"],
    ["error", "queued"],
    ["start", "queued"],
  ])("keeps member state when the same attempt regresses from %s to %s", (state, staleState) => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state, attempt: 2, resultPreview: "Current result" })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([
        agent({ state: staleState, attempt: 2, resultPreview: "Old result" }),
      ]),
    });
    expect(second?.agents).toEqual(first?.agents);
  });

  it("retains member fields omitted by a later frame in the same attempt", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        agent({
          attempt: 2,
          model: "claude-opus-5[1m]",
          promptPreview: "Current prompt",
          tokens: 100,
        }),
      ]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first && {
        ...first,
        agents: first.agents.map((member) => ({ ...member, effort: "xhigh", speed: "standard" })),
      },
      message: snapshotFrame([agent({ state: "done", resultPreview: "Current result" })]),
    });
    expect(second?.agents[0]).toMatchObject({
      state: "completed",
      attempt: 2,
      prompt: "Current prompt",
      result: "Current result",
      totalTokens: 100,
      model: "claude-opus-5[1m]",
      effort: "xhigh",
      speed: "standard",
    });
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
