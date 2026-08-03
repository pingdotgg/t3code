import { describe, expect, it } from "vite-plus/test";

import type { AgentRun, AgentRunPhase } from "../../agentRuns.ts";
import {
  AGENT_RUN_TRACKER_FINISHED_CAP,
  agentRunIsJumpable,
  agentRunTrackerRows,
  agentRunTrackerTooltip,
  selectAgentRunTrackerState,
  shouldRevealFinishedOnOpen,
} from "./AgentRunTracker.logic.ts";

function run(overrides: Partial<AgentRun> & { taskId: string }): AgentRun {
  return {
    rowId: `row-${overrides.taskId}`,
    createdAt: "2026-07-18T00:00:00.000Z",
    settledAt: null,
    turnId: null,
    title: "Agent run",
    phase: "running" as AgentRunPhase,
    ambient: false,
    detailsUnavailable: false,
    feed: [],
    ...overrides,
  };
}

describe("selectAgentRunTrackerState", () => {
  it("stays hidden for a thread that never dispatched an agent", () => {
    const state = selectAgentRunTrackerState([]);
    expect(state.visible).toBe(false);
    expect(state.active).toBe(false);
    expect(state.count).toBe(0);
  });

  it("splits running from settled and counts the running ones while anything is live", () => {
    const state = selectAgentRunTrackerState([
      run({ taskId: "done-1", phase: "done", settledAt: "2026-07-18T00:00:05.000Z" }),
      run({ taskId: "live-1" }),
      run({ taskId: "live-2" }),
    ]);
    expect(state.running.map((entry) => entry.taskId)).toEqual(["live-1", "live-2"]);
    expect(state.finished.map((entry) => entry.taskId)).toEqual(["done-1"]);
    expect(state.count).toBe(2);
    expect(state.active).toBe(true);
    expect(state.visible).toBe(true);
  });

  it("falls back to the settled count, with no pulse, once nothing is running", () => {
    const state = selectAgentRunTrackerState([
      run({ taskId: "a", phase: "failed", settledAt: "2026-07-18T00:00:02.000Z" }),
      run({ taskId: "b", phase: "stopped", settledAt: "2026-07-18T00:00:03.000Z" }),
    ]);
    expect(state.active).toBe(false);
    expect(state.count).toBe(2);
    expect(state.visible).toBe(true);
  });

  it("orders running by timeline position and settled newest first", () => {
    const state = selectAgentRunTrackerState([
      run({ taskId: "late", createdAt: "2026-07-18T00:00:09.000Z" }),
      run({ taskId: "early", createdAt: "2026-07-18T00:00:01.000Z" }),
      run({ taskId: "old-done", phase: "done", settledAt: "2026-07-18T00:00:04.000Z" }),
      run({ taskId: "new-done", phase: "done", settledAt: "2026-07-18T00:00:08.000Z" }),
    ]);
    expect(state.running.map((entry) => entry.taskId)).toEqual(["early", "late"]);
    expect(state.finished.map((entry) => entry.taskId)).toEqual(["new-done", "old-done"]);
  });

  it("caps the settled list so the popover cannot grow without bound", () => {
    const runs = Array.from({ length: AGENT_RUN_TRACKER_FINISHED_CAP + 7 }, (_, index) =>
      run({
        taskId: `done-${index}`,
        phase: "done",
        settledAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const state = selectAgentRunTrackerState(runs);
    expect(state.finished).toHaveLength(AGENT_RUN_TRACKER_FINISHED_CAP);
    // Newest kept, oldest dropped.
    expect(state.finished[0]?.taskId).toBe(`done-${AGENT_RUN_TRACKER_FINISHED_CAP + 6}`);
  });

  it("keeps ambient runs, which the transcript hides but a tasks panel may show", () => {
    const state = selectAgentRunTrackerState([run({ taskId: "ambient-1", ambient: true })]);
    expect(state.running.map((entry) => entry.taskId)).toEqual(["ambient-1"]);
    expect(state.visible).toBe(true);
  });
});

describe("agentRunTrackerRows", () => {
  it("shows running only by default and appends settled behind the disclosure", () => {
    const state = selectAgentRunTrackerState([
      run({ taskId: "live" }),
      run({ taskId: "done", phase: "done", settledAt: "2026-07-18T00:00:05.000Z" }),
    ]);
    expect(agentRunTrackerRows(state, false).map((entry) => entry.taskId)).toEqual(["live"]);
    expect(agentRunTrackerRows(state, true).map((entry) => entry.taskId)).toEqual(["live", "done"]);
  });
});

describe("agentRunIsJumpable", () => {
  it("refuses ambient runs, which have no transcript row to scroll to", () => {
    expect(agentRunIsJumpable(run({ taskId: "a" }))).toBe(true);
    expect(agentRunIsJumpable(run({ taskId: "b", ambient: true }))).toBe(false);
  });
});

describe("agentRunTrackerTooltip", () => {
  it("singularizes both branches", () => {
    expect(agentRunTrackerTooltip(1, 0)).toBe("1 agent run in progress");
    expect(agentRunTrackerTooltip(2, 0)).toBe("2 agent runs in progress");
    expect(agentRunTrackerTooltip(0, 1)).toBe("1 finished agent run");
    expect(agentRunTrackerTooltip(0, 3)).toBe("3 finished agent runs");
  });
});

// The popover used to collapse to a 12px strip when the last run settled while
// it was open: `agentRunTrackerRows` returns nothing, and the body had no empty
// state. Both halves of that are pinned here.
describe("agentRunTrackerRows (empty body)", () => {
  it("returns no rows when everything settled and finished is still hidden", () => {
    const state = selectAgentRunTrackerState([
      run({ taskId: "done", phase: "done", settledAt: "2026-07-18T00:00:05.000Z" }),
    ]);
    expect(agentRunTrackerRows(state, false)).toEqual([]);
    // …which is exactly when the disclosure should reveal itself.
    expect(shouldRevealFinishedOnOpen(state)).toBe(true);
  });

  it("keeps the disclosure closed while anything is still running", () => {
    const state = selectAgentRunTrackerState([
      run({ taskId: "live" }),
      run({ taskId: "done", phase: "done", settledAt: "2026-07-18T00:00:05.000Z" }),
    ]);
    expect(shouldRevealFinishedOnOpen(state)).toBe(false);
    expect(agentRunTrackerRows(state, false)).toHaveLength(1);
  });
});
