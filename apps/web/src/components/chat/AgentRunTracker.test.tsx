import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRun } from "../../agentRuns.ts";
import { AgentRunTracker } from "./AgentRunTracker.tsx";

function run(overrides: Partial<AgentRun> & { taskId: string }): AgentRun {
  return {
    rowId: `row-${overrides.taskId}`,
    createdAt: "2026-07-18T00:00:00.000Z",
    settledAt: null,
    turnId: null,
    title: "Agent run",
    phase: "running",
    ambient: false,
    detailsUnavailable: false,
    feed: [],
    ...overrides,
  };
}

describe("AgentRunTracker", () => {
  it("renders nothing for a thread with no agent runs", () => {
    expect(renderToStaticMarkup(<AgentRunTracker runs={[]} />)).toBe("");
  });

  it("renders the running count and announces it", () => {
    const markup = renderToStaticMarkup(
      <AgentRunTracker runs={[run({ taskId: "t1" }), run({ taskId: "t2" })]} />,
    );
    expect(markup).toContain("2 agent runs in progress");
    expect(markup).toContain("animate-status-pulse");
  });

  it("falls back to the finished count with no pulsing dot once nothing is running", () => {
    const markup = renderToStaticMarkup(
      <AgentRunTracker
        runs={[run({ taskId: "t1", phase: "done", settledAt: "2026-07-18T00:00:04.000Z" })]}
      />,
    );
    expect(markup).toContain("1 finished agent run");
    expect(markup).not.toContain("animate-status-pulse");
  });
});
