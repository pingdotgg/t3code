import {
  AgentProfileId,
  AgentProfileRef,
  AgentProfileRevision,
  AgentRunId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decide,
  emptyAgentRunState,
  evolveAll,
  summaryOf,
  type AgentRunCommand,
  type AgentRunEvent,
  type AgentRunState,
} from "./AgentRun.ts";

const at = "2026-08-07T12:00:00.000Z";
const later = "2026-08-07T12:01:00.000Z";
const profile = AgentProfileRef.make({
  id: AgentProfileId.make("reviewer"),
  scope: "environment",
  revision: AgentProfileRevision.make("a".repeat(64)),
});
const budget = {
  maxRuns: 4,
  maxConcurrency: 2,
  maxDepth: 2,
  maxWallTimeMinutes: 10,
  maxTotalTokens: 100,
};
const launch = {
  parentThreadId: ThreadId.make("parent-thread"),
  projectId: ProjectId.make("project"),
  modelSelection: ModelSelection.make({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  }),
  instanceId: ProviderInstanceId.make("codex"),
  workspaceMode: "shared" as const,
};
const id = (value: string) => AgentRunId.make(value);
const thread = (value: string) => ThreadId.make(value);

type RequestCommand = Extract<AgentRunCommand, { readonly type: "agent-run.request" }>;

const request = (
  runId: string,
  parentRunId: string | null = null,
  detached = false,
): RequestCommand => ({
  type: "agent-run.request",
  runId: id(runId),
  profile,
  budget,
  parentRunId: parentRunId === null ? null : id(parentRunId),
  detached,
  ...launch,
  occurredAt: at,
});

const transition = (state: AgentRunState, command: AgentRunCommand): AgentRunState =>
  evolveAll(state, Effect.runSync(decide(state, command)));

const start = (state: AgentRunState, runId: string): AgentRunState =>
  transition(
    transition(state, {
      type: "agent-run.assign-child-thread",
      runId: id(runId),
      childThreadId: thread(`${runId}-thread`),
      occurredAt: at,
    }),
    { type: "agent-run.start", runId: id(runId), occurredAt: later },
  );

describe("AgentRun", () => {
  it("requests, assigns, starts, waits, and completes a run with contract summary fields", () => {
    const requested = transition(emptyAgentRunState(), request("root"));
    const assignedAndStarted = start(requested, "root");
    const waiting = transition(assignedAndStarted, {
      type: "agent-run.wait",
      runId: id("root"),
      occurredAt: later,
    });
    const completed = transition(waiting, {
      type: "agent-run.succeed",
      runId: id("root"),
      usage: { totalTokens: 7, inputTokens: 4 },
      occurredAt: later,
    });
    const run = completed.runs.get(id("root"));

    expect(run?.status).toBe("succeeded");
    expect(run?.revision).toBe(4);
    expect(summaryOf(run!).usage).toEqual({ totalTokens: 7, inputTokens: 4 });
    expect(summaryOf(run!).finishedAt).toBe(later);
  });

  it("puts an attached parent in child-wait and resumes it after the last child settles", () => {
    const parent = start(transition(emptyAgentRunState(), request("parent")), "parent");
    const events = Effect.runSync(decide(parent, request("child", "parent")));
    const waiting = evolveAll(parent, events);
    expect(events.map((event) => event.type)).toEqual(["agent-run.waiting", "agent-run.requested"]);
    expect(waiting.runs.get(id("parent"))?.status).toBe("waiting-for-input");
    expect(waiting.runs.get(id("parent"))?.waitingForChildren).toBe(true);

    const child = start(waiting, "child");
    const settled = transition(child, {
      type: "agent-run.succeed",
      runId: id("child"),
      occurredAt: later,
    });
    expect(settled.runs.get(id("child"))?.status).toBe("succeeded");
    expect(settled.runs.get(id("parent"))?.status).toBe("running");
  });

  it("leaves detached parents running and does not resume them when a child settles", () => {
    const parent = start(transition(emptyAgentRunState(), request("parent")), "parent");
    const child = transition(parent, request("child", "parent", true));
    expect(child.runs.get(id("parent"))?.status).toBe("running");

    const complete = transition(start(child, "child"), {
      type: "agent-run.succeed",
      runId: id("child"),
      occurredAt: later,
    });
    expect(complete.runs.get(id("parent"))?.status).toBe("running");
  });

  it("enforces inherited depth, run-count, concurrency, and token budgets", () => {
    const constrainedBudget = {
      ...budget,
      maxRuns: 2,
      maxConcurrency: 1,
      maxDepth: 1,
      maxTotalTokens: 5,
    };
    let state = transition(emptyAgentRunState(), { ...request("root"), budget: constrainedBudget });
    state = start(state, "root");
    expect(() =>
      Effect.runSync(
        decide(state, { ...request("child", "root", true), budget: constrainedBudget }),
      ),
    ).toThrow(/concurrency budget/);

    const parentWaiting = transition(state, {
      type: "agent-run.wait",
      runId: id("root"),
      occurredAt: later,
    });
    const child = transition(parentWaiting, {
      ...request("child", "root"),
      budget: constrainedBudget,
    });
    expect(() =>
      Effect.runSync(
        decide(child, { ...request("grandchild", "child"), budget: constrainedBudget }),
      ),
    ).toThrow(/depth budget/);
    expect(() =>
      Effect.runSync(decide(child, { ...request("other", "root"), budget: constrainedBudget })),
    ).toThrow(/run budget/);

    const completedRoot = transition(parentWaiting, {
      type: "agent-run.succeed",
      runId: id("root"),
      usage: { totalTokens: 5 },
      occurredAt: later,
    });
    expect(() =>
      Effect.runSync(
        decide(completedRoot, {
          type: "agent-run.follow-up",
          runId: id("root"),
          message: "one more pass",
          occurredAt: later,
        }),
      ),
    ).toThrow(/total-token budget/);

    const almostCompleted = transition(
      start(
        transition(emptyAgentRunState(), {
          ...request("almost"),
          budget: constrainedBudget,
        }),
        "almost",
      ),
      {
        type: "agent-run.succeed",
        runId: id("almost"),
        usage: { totalTokens: 4 },
        occurredAt: later,
      },
    );
    const revised = transition(almostCompleted, {
      type: "agent-run.follow-up",
      runId: id("almost"),
      message: "one more pass",
      occurredAt: later,
    });
    const activeAgain = transition(revised, {
      type: "agent-run.start",
      runId: id("almost"),
      occurredAt: later,
    });
    expect(() =>
      Effect.runSync(
        decide(activeAgain, {
          type: "agent-run.succeed",
          runId: id("almost"),
          usage: { totalTokens: 2 },
          occurredAt: later,
        }),
      ),
    ).toThrow(/total-token budget/);

    const { maxTotalTokens: _maxTotalTokens, ...budgetWithoutTokens } = budget;
    const costBudget = {
      ...budgetWithoutTokens,
      maxEstimatedCostUsd: 0.5,
    };
    const costCompleted = transition(
      start(
        transition(emptyAgentRunState(), { ...request("costed"), budget: costBudget }),
        "costed",
      ),
      {
        type: "agent-run.succeed",
        runId: id("costed"),
        usage: { totalTokens: 4, estimatedCostUsd: 0.4 },
        occurredAt: later,
      },
    );
    const costRevised = transition(costCompleted, {
      type: "agent-run.follow-up",
      runId: id("costed"),
      message: "one more costed pass",
      occurredAt: later,
    });
    const costActiveAgain = transition(costRevised, {
      type: "agent-run.start",
      runId: id("costed"),
      occurredAt: later,
    });
    expect(() =>
      Effect.runSync(
        decide(costActiveAgain, {
          type: "agent-run.succeed",
          runId: id("costed"),
          usage: { totalTokens: 2, estimatedCostUsd: 0.2 },
          occurredAt: later,
        }),
      ),
    ).toThrow(/estimated-cost budget/);
  });

  it("reopens only successful results for follow-up revisions", () => {
    const completed = transition(start(transition(emptyAgentRunState(), request("root")), "root"), {
      type: "agent-run.succeed",
      runId: id("root"),
      occurredAt: later,
    });
    const revised = transition(completed, {
      type: "agent-run.follow-up",
      runId: id("root"),
      message: "address the review",
      occurredAt: later,
    });
    expect(revised.runs.get(id("root"))?.status).toBe("queued");
    expect(revised.runs.get(id("root"))?.revision).toBe(4);
  });

  it("makes cancellation idempotent after terminal transitions", () => {
    const cancelled = transition(start(transition(emptyAgentRunState(), request("root")), "root"), {
      type: "agent-run.cancel",
      runId: id("root"),
      occurredAt: later,
    });
    const noEvents = Effect.runSync(
      decide(cancelled, { type: "agent-run.cancel", runId: id("root"), occurredAt: later }),
    );
    expect(noEvents).toEqual([]);
    expect(evolveAll(cancelled, noEvents)).toBe(cancelled);
  });

  it("moves through integration, retaining a conflict as a retryable successful result", () => {
    const succeeded = transition(start(transition(emptyAgentRunState(), request("root")), "root"), {
      type: "agent-run.succeed",
      runId: id("root"),
      occurredAt: later,
    });
    const integrating = transition(succeeded, {
      type: "agent-run.start-integration",
      runId: id("root"),
      targetThreadId: thread("target"),
      occurredAt: later,
    });
    const conflicted = transition(integrating, {
      type: "agent-run.conflict-integration",
      runId: id("root"),
      failure: "Conflicting changes",
      occurredAt: later,
    });
    expect(conflicted.runs.get(id("root"))?.status).toBe("succeeded");
    expect(conflicted.runs.get(id("root"))?.failure).toBe("Conflicting changes");

    const reintegrating = transition(conflicted, {
      type: "agent-run.start-integration",
      runId: id("root"),
      targetThreadId: thread("target"),
      occurredAt: later,
    });
    const integrated = transition(reintegrating, {
      type: "agent-run.succeed-integration",
      runId: id("root"),
      occurredAt: later,
    });
    expect(integrated.runs.get(id("root"))?.status).toBe("integrated");
  });

  it("is replay deterministic", () => {
    const commands: ReadonlyArray<AgentRunCommand> = [
      request("root"),
      {
        type: "agent-run.assign-child-thread",
        runId: id("root"),
        childThreadId: thread("root-thread"),
        occurredAt: at,
      },
      { type: "agent-run.start", runId: id("root"), occurredAt: later },
      {
        type: "agent-run.succeed",
        runId: id("root"),
        usage: { totalTokens: 2 },
        occurredAt: later,
      },
    ];
    let state = emptyAgentRunState();
    const events: Array<AgentRunEvent> = [];
    for (const command of commands) {
      const next = Effect.runSync(decide(state, command));
      events.push(...next);
      state = evolveAll(state, next);
    }
    expect(evolveAll(emptyAgentRunState(), events)).toEqual(state);
  });
});
