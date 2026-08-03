import { describe, expect, it } from "vite-plus/test";

import type { AgentRun } from "../../agentRuns.ts";
import {
  AGENT_RUN_STOP_REENABLE_MS,
  agentRunIsStoppable,
  agentRunStopAllLabel,
  agentRunStopButtonState,
  agentRunStopFailureMessage,
  EMPTY_AGENT_RUN_STOP_REQUESTS,
  isAgentRunStopPending,
  pruneAgentRunStopRequests,
  stoppableAgentRuns,
  withAgentRunStopRequested,
  withoutAgentRunStopRequested,
} from "./agentRunStop.logic.ts";

const T0 = 1_000_000;

function makeRun(overrides: Partial<AgentRun> & { taskId: string }): AgentRun {
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

describe("stop request bookkeeping", () => {
  it("marks a task pending and re-enables it after the window", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["t1"], T0);
    expect(isAgentRunStopPending(requests, "t1", T0)).toBe(true);
    expect(isAgentRunStopPending(requests, "t1", T0 + AGENT_RUN_STOP_REENABLE_MS - 1)).toBe(true);
    expect(isAgentRunStopPending(requests, "t1", T0 + AGENT_RUN_STOP_REENABLE_MS)).toBe(false);
  });

  it("never reports an unrequested task as pending", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["t1"], T0);
    expect(isAgentRunStopPending(requests, "t2", T0)).toBe(false);
  });

  it("re-requesting restarts the window rather than being ignored", () => {
    const first = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["t1"], T0);
    const second = withAgentRunStopRequested(first, ["t1"], T0 + AGENT_RUN_STOP_REENABLE_MS);
    expect(isAgentRunStopPending(second, "t1", T0 + AGENT_RUN_STOP_REENABLE_MS + 1)).toBe(true);
  });

  it("marks every task of a Stop all press", () => {
    const requests = withAgentRunStopRequested(
      EMPTY_AGENT_RUN_STOP_REQUESTS,
      ["t1", "t2", "t3"],
      T0,
    );
    expect(Object.keys(requests).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("returns the same object when there is nothing to record or prune", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["t1"], T0);
    expect(withAgentRunStopRequested(requests, [], T0)).toBe(requests);
    expect(pruneAgentRunStopRequests(requests, T0)).toBe(requests);
  });

  it("prunes expired entries", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["t1", "t2"], T0);
    const later = withAgentRunStopRequested(requests, ["t2"], T0 + AGENT_RUN_STOP_REENABLE_MS);
    const pruned = pruneAgentRunStopRequests(later, T0 + AGENT_RUN_STOP_REENABLE_MS + 1);
    expect(Object.keys(pruned)).toEqual(["t2"]);
  });
});

describe("stoppability", () => {
  it("counts only non-terminal runs, ambient included", () => {
    const runs = [
      makeRun({ taskId: "t1" }),
      makeRun({ taskId: "t2", ambient: true }),
      makeRun({ taskId: "t3", phase: "done" }),
      makeRun({ taskId: "t4", phase: "failed" }),
      makeRun({ taskId: "t5", phase: "stopped" }),
    ];
    expect(stoppableAgentRuns(runs).map((run) => run.taskId)).toEqual(["t1", "t2"]);
    expect(agentRunIsStoppable(makeRun({ taskId: "t3", phase: "done" }))).toBe(false);
  });
});

describe("agentRunStopButtonState", () => {
  const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["t1"], T0);

  it("hides the button for a settled run", () => {
    expect(
      agentRunStopButtonState({
        run: makeRun({ taskId: "t2", phase: "done" }),
        requests,
        now: T0,
        enabled: true,
      }),
    ).toBe("hidden");
  });

  it("hides the button when no thread can be addressed", () => {
    expect(
      agentRunStopButtonState({
        run: makeRun({ taskId: "t1" }),
        requests,
        now: T0,
        enabled: false,
      }),
    ).toBe("hidden");
  });

  it("is pending inside the window and idle again after it", () => {
    const run = makeRun({ taskId: "t1" });
    expect(agentRunStopButtonState({ run, requests, now: T0, enabled: true })).toBe("pending");
    expect(
      agentRunStopButtonState({
        run,
        requests,
        now: T0 + AGENT_RUN_STOP_REENABLE_MS,
        enabled: true,
      }),
    ).toBe("idle");
  });
});

describe("copy", () => {
  it("labels the two presses of Stop all", () => {
    expect(agentRunStopAllLabel(3, false)).toBe("Stop all (3)");
    expect(agentRunStopAllLabel(3, true)).toBe("Stop 3 runs?");
    expect(agentRunStopAllLabel(1, true)).toBe("Stop it?");
  });

  it("phrases an unsupported provider without calling it a failure", () => {
    expect(agentRunStopFailureMessage({ _tag: "ProviderTaskStopUnsupportedError" })).toBe(
      "This provider can't stop tasks.",
    );
  });

  it("passes a real error message through and falls back otherwise", () => {
    expect(agentRunStopFailureMessage(new Error("session closed"))).toBe("session closed");
    expect(agentRunStopFailureMessage(new Error("   "))).toBe(
      "The server refused the stop request.",
    );
    expect(agentRunStopFailureMessage(undefined)).toBe("The server refused the stop request.");
  });
});

// F-32 — the "Stopping…" mark is written optimistically before the RPC. It
// used to survive a refusal for the whole re-enable window, so the card said
// "Stopping…" with a disabled button while the failure toast was on screen.
describe("withoutAgentRunStopRequested (F-32)", () => {
  it("drops the pending mark for a refused stop", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["a", "b"], 1_000);
    const cleared = withoutAgentRunStopRequested(requests, ["a"]);
    expect(isAgentRunStopPending(cleared, "a", 1_100)).toBe(false);
    expect(isAgentRunStopPending(cleared, "b", 1_100)).toBe(true);
  });

  it("keeps identity when nothing was marked, so the store skips a notify", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["a"], 1_000);
    expect(withoutAgentRunStopRequested(requests, ["zzz"])).toBe(requests);
    expect(withoutAgentRunStopRequested(requests, [])).toBe(requests);
  });

  it("does not mutate the set it was handed", () => {
    const requests = withAgentRunStopRequested(EMPTY_AGENT_RUN_STOP_REQUESTS, ["a"], 1_000);
    withoutAgentRunStopRequested(requests, ["a"]);
    expect(isAgentRunStopPending(requests, "a", 1_100)).toBe(true);
  });
});
