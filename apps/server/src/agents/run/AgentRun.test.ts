import {
  AgentProfileId,
  AgentProfileRef,
  AgentProfileRevision,
  AgentRunId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  AgentRunCommandInvariantError,
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

const transition = (state: AgentRunState, command: AgentRunCommand) =>
  Effect.map(decide(state, command), (events) => evolveAll(state, events));

const start = (state: AgentRunState, runId: string) =>
  Effect.gen(function* () {
    const assigned = yield* transition(state, {
      type: "agent-run.assign-child-thread",
      runId: id(runId),
      childThreadId: thread(`${runId}-thread`),
      occurredAt: at,
    });
    return yield* transition(assigned, {
      type: "agent-run.start",
      runId: id(runId),
      occurredAt: later,
    });
  });

const expectInvariantFailure = (
  effect: Effect.Effect<unknown, Error>,
  pattern: RegExp,
  reason?: AgentRunCommandInvariantError["reason"],
) =>
  Effect.match(effect, {
    onFailure: (error) => {
      expect(error.message).toMatch(pattern);
      if (reason !== undefined) {
        expect(error).toBeInstanceOf(AgentRunCommandInvariantError);
        expect((error as AgentRunCommandInvariantError).reason).toBe(reason);
      }
    },
    onSuccess: () => expect.fail("Expected an AgentRun invariant failure."),
  });

describe("AgentRun", () => {
  it.effect(
    "requests, assigns, starts, waits, and completes a run with contract summary fields",
    () =>
      Effect.gen(function* () {
        const requested = yield* transition(emptyAgentRunState(), request("root"));
        const assignedAndStarted = yield* start(requested, "root");
        const waiting = yield* transition(assignedAndStarted, {
          type: "agent-run.wait",
          runId: id("root"),
          occurredAt: later,
        });
        const completed = yield* transition(waiting, {
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
      }),
  );

  it.effect("binds only the current provider turn after a follow-up revision", () =>
    Effect.gen(function* () {
      const firstTurn = TurnId.make("provider-turn-first");
      const currentTurn = TurnId.make("provider-turn-current");
      const followUpAt = "2026-08-07T12:02:00.000Z";
      const restartedAt = "2026-08-07T12:03:00.000Z";
      const currentStartedAt = "2026-08-07T12:04:00.000Z";
      let state = yield* start(
        yield* transition(emptyAgentRunState(), request("follow-up-root")),
        "follow-up-root",
      );
      state = yield* transition(state, {
        type: "agent-run.bind-turn",
        runId: id("follow-up-root"),
        turnId: firstTurn,
        occurredAt: later,
      });
      state = yield* transition(state, {
        type: "agent-run.succeed",
        runId: id("follow-up-root"),
        occurredAt: later,
      });
      state = yield* transition(state, {
        type: "agent-run.follow-up",
        runId: id("follow-up-root"),
        message: "Continue with the next task.",
        occurredAt: followUpAt,
      });
      state = yield* transition(state, {
        type: "agent-run.start",
        runId: id("follow-up-root"),
        occurredAt: restartedAt,
      });

      const stale = yield* decide(state, {
        type: "agent-run.bind-turn",
        runId: id("follow-up-root"),
        turnId: firstTurn,
        occurredAt: later,
      });
      expect(stale).toEqual([]);
      state = yield* transition(state, {
        type: "agent-run.bind-turn",
        runId: id("follow-up-root"),
        turnId: currentTurn,
        occurredAt: currentStartedAt,
      });

      const run = state.runs.get(id("follow-up-root"));
      expect(run?.status).toBe("running");
      expect(run?.activeTurnId).toBe(currentTurn);
    }),
  );

  it.effect(
    "puts an attached parent in child-wait and resumes it after the last child settles",
    () =>
      Effect.gen(function* () {
        const parent = yield* start(
          yield* transition(emptyAgentRunState(), request("parent")),
          "parent",
        );
        const events = yield* decide(parent, request("child", "parent"));
        const waiting = evolveAll(parent, events);
        expect(events.map((event) => event.type)).toEqual([
          "agent-run.waiting",
          "agent-run.requested",
        ]);
        expect(waiting.runs.get(id("parent"))?.status).toBe("waiting-for-input");
        expect(waiting.runs.get(id("parent"))?.waitingForChildren).toBe(true);

        const child = yield* start(waiting, "child");
        const settled = yield* transition(child, {
          type: "agent-run.succeed",
          runId: id("child"),
          occurredAt: later,
        });
        expect(settled.runs.get(id("child"))?.status).toBe("succeeded");
        expect(settled.runs.get(id("parent"))?.status).toBe("running");
      }),
  );

  it.effect("leaves detached parents running and does not resume them when a child settles", () =>
    Effect.gen(function* () {
      const parent = yield* start(
        yield* transition(emptyAgentRunState(), request("parent")),
        "parent",
      );
      const child = yield* transition(parent, request("child", "parent", true));
      expect(child.runs.get(id("parent"))?.status).toBe("running");

      const complete = yield* transition(yield* start(child, "child"), {
        type: "agent-run.succeed",
        runId: id("child"),
        occurredAt: later,
      });
      expect(complete.runs.get(id("parent"))?.status).toBe("running");
    }),
  );

  it.effect("enforces inherited depth, run-count, concurrency, and token budgets", () =>
    Effect.gen(function* () {
      const constrainedBudget = {
        ...budget,
        maxRuns: 2,
        maxConcurrency: 1,
        maxDepth: 1,
        maxTotalTokens: 5,
      };
      let state = yield* transition(emptyAgentRunState(), {
        ...request("root"),
        budget: constrainedBudget,
      });
      state = yield* start(state, "root");
      yield* expectInvariantFailure(
        decide(state, { ...request("child", "root", true), budget: constrainedBudget }),
        /concurrency budget/,
      );

      const parentWaiting = yield* transition(state, {
        type: "agent-run.wait",
        runId: id("root"),
        occurredAt: later,
      });
      const child = yield* transition(parentWaiting, {
        ...request("child", "root"),
        budget: constrainedBudget,
      });
      yield* expectInvariantFailure(
        decide(child, { ...request("grandchild", "child"), budget: constrainedBudget }),
        /depth budget/,
      );
      yield* expectInvariantFailure(
        decide(child, { ...request("other", "root"), budget: constrainedBudget }),
        /run budget/,
      );

      const completedRoot = yield* transition(parentWaiting, {
        type: "agent-run.succeed",
        runId: id("root"),
        usage: { totalTokens: 5 },
        occurredAt: later,
      });
      yield* expectInvariantFailure(
        decide(completedRoot, {
          type: "agent-run.follow-up",
          runId: id("root"),
          message: "one more pass",
          occurredAt: later,
        }),
        /total-token budget/,
      );

      const almostCompleted = yield* transition(
        yield* start(
          yield* transition(emptyAgentRunState(), {
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
      const revised = yield* transition(almostCompleted, {
        type: "agent-run.follow-up",
        runId: id("almost"),
        message: "one more pass",
        occurredAt: later,
      });
      const activeAgain = yield* transition(revised, {
        type: "agent-run.start",
        runId: id("almost"),
        occurredAt: later,
      });
      yield* expectInvariantFailure(
        decide(activeAgain, {
          type: "agent-run.succeed",
          runId: id("almost"),
          usage: { totalTokens: 2 },
          occurredAt: later,
        }),
        /total-token budget/,
        "budget-exhausted",
      );

      const { maxTotalTokens: _maxTotalTokens, ...budgetWithoutTokens } = budget;
      const costBudget = {
        ...budgetWithoutTokens,
        maxEstimatedCostUsd: 0.5,
      };
      const costCompleted = yield* transition(
        yield* start(
          yield* transition(emptyAgentRunState(), { ...request("costed"), budget: costBudget }),
          "costed",
        ),
        {
          type: "agent-run.succeed",
          runId: id("costed"),
          usage: { totalTokens: 4, estimatedCostUsd: 0.4 },
          occurredAt: later,
        },
      );
      const costRevised = yield* transition(costCompleted, {
        type: "agent-run.follow-up",
        runId: id("costed"),
        message: "one more costed pass",
        occurredAt: later,
      });
      const costActiveAgain = yield* transition(costRevised, {
        type: "agent-run.start",
        runId: id("costed"),
        occurredAt: later,
      });
      yield* expectInvariantFailure(
        decide(costActiveAgain, {
          type: "agent-run.succeed",
          runId: id("costed"),
          usage: { totalTokens: 2, estimatedCostUsd: 0.2 },
          occurredAt: later,
        }),
        /estimated-cost budget/,
      );
    }),
  );

  it.effect("refuses a child before it can spawn when lineage tokens or cost are spent", () =>
    Effect.gen(function* () {
      const tokenBudget = { ...budget, maxTotalTokens: 5 };
      const tokenRoot = yield* transition(
        yield* start(
          yield* transition(
            yield* start(
              yield* transition(emptyAgentRunState(), {
                ...request("token-root"),
                budget: tokenBudget,
              }),
              "token-root",
            ),
            { ...request("token-spent", "token-root"), budget: tokenBudget },
          ),
          "token-spent",
        ),
        {
          type: "agent-run.succeed",
          runId: id("token-spent"),
          usage: { totalTokens: 5 },
          occurredAt: later,
        },
      );
      yield* expectInvariantFailure(
        decide(tokenRoot, { ...request("token-child", "token-root"), budget: tokenBudget }),
        /total-token budget/,
        "budget-exhausted",
      );

      const { maxTotalTokens: _maxTotalTokens, ...withoutTokens } = budget;
      const costBudget = { ...withoutTokens, maxEstimatedCostUsd: 0.5 };
      const costRoot = yield* transition(
        yield* start(
          yield* transition(
            yield* start(
              yield* transition(emptyAgentRunState(), {
                ...request("cost-root"),
                budget: costBudget,
              }),
              "cost-root",
            ),
            { ...request("cost-spent", "cost-root"), budget: costBudget },
          ),
          "cost-spent",
        ),
        {
          type: "agent-run.succeed",
          runId: id("cost-spent"),
          usage: { totalTokens: 0, estimatedCostUsd: 0.5 },
          occurredAt: later,
        },
      );
      yield* expectInvariantFailure(
        decide(costRoot, { ...request("cost-child", "cost-root"), budget: costBudget }),
        /estimated-cost budget/,
        "budget-exhausted",
      );
    }),
  );

  it.effect("enforces a child's reduced lineage run and concurrency caps", () =>
    Effect.gen(function* () {
      const rootBudget = { ...budget, maxRuns: 4, maxConcurrency: 2 };
      const childRunBudget = { ...rootBudget, maxRuns: 2 };
      const withChild = yield* transition(
        yield* start(
          yield* transition(emptyAgentRunState(), { ...request("root"), budget: rootBudget }),
          "root",
        ),
        { ...request("child", "root"), budget: childRunBudget },
      );
      yield* expectInvariantFailure(
        decide(withChild, { ...request("grandchild", "child"), budget: childRunBudget }),
        /run budget/,
        "budget-exhausted",
      );

      const childConcurrencyBudget = { ...rootBudget, maxConcurrency: 1 };
      const runningChild = yield* start(
        yield* transition(
          yield* start(
            yield* transition(emptyAgentRunState(), { ...request("root"), budget: rootBudget }),
            "root",
          ),
          { ...request("child", "root"), budget: childConcurrencyBudget },
        ),
        "child",
      );
      yield* expectInvariantFailure(
        decide(runningChild, {
          ...request("grandchild", "child", true),
          budget: childConcurrencyBudget,
        }),
        /concurrency budget/,
        "budget-exhausted",
      );
    }),
  );

  it.effect("reopens only successful results for follow-up revisions", () =>
    Effect.gen(function* () {
      const completed = yield* transition(
        yield* start(yield* transition(emptyAgentRunState(), request("root")), "root"),
        {
          type: "agent-run.succeed",
          runId: id("root"),
          usage: { totalTokens: 2 },
          occurredAt: later,
        },
      );
      const revised = yield* transition(completed, {
        type: "agent-run.follow-up",
        runId: id("root"),
        message: "address the review",
        occurredAt: later,
      });
      expect(revised.runs.get(id("root"))?.status).toBe("queued");
      expect(revised.runs.get(id("root"))?.revision).toBe(4);
      expect(revised.runs.get(id("root"))?.usage).toBeUndefined();
      expect(revised.runs.get(id("root"))?.consumedTokens).toBe(2);
    }),
  );

  it.effect("makes cancellation idempotent after terminal transitions", () =>
    Effect.gen(function* () {
      const cancelled = yield* transition(
        yield* start(yield* transition(emptyAgentRunState(), request("root")), "root"),
        {
          type: "agent-run.cancel",
          runId: id("root"),
          occurredAt: later,
        },
      );
      const noEvents = yield* decide(cancelled, {
        type: "agent-run.cancel",
        runId: id("root"),
        occurredAt: later,
      });
      expect(noEvents).toEqual([]);
      expect(evolveAll(cancelled, noEvents)).toBe(cancelled);
    }),
  );

  it.effect("permits spawn compensation to fail a run after it has started", () =>
    Effect.gen(function* () {
      const started = yield* start(
        yield* transition(emptyAgentRunState(), request("root")),
        "root",
      );
      const compensated = yield* transition(started, {
        type: "agent-run.fail",
        runId: id("root"),
        failure: "T3 could not start the child Agent turn.",
        occurredAt: later,
      });
      expect(compensated.runs.get(id("root"))?.status).toBe("failed");
    }),
  );

  it.effect(
    "moves through integration, retaining a conflict as a retryable successful result",
    () =>
      Effect.gen(function* () {
        const succeeded = yield* transition(
          yield* start(yield* transition(emptyAgentRunState(), request("root")), "root"),
          {
            type: "agent-run.succeed",
            runId: id("root"),
            occurredAt: later,
          },
        );
        const integrating = yield* transition(succeeded, {
          type: "agent-run.start-integration",
          runId: id("root"),
          targetThreadId: thread("target"),
          occurredAt: later,
        });
        const conflicted = yield* transition(integrating, {
          type: "agent-run.conflict-integration",
          runId: id("root"),
          failure: "Conflicting changes",
          occurredAt: later,
        });
        expect(conflicted.runs.get(id("root"))?.status).toBe("succeeded");
        expect(conflicted.runs.get(id("root"))?.failure).toBe("Conflicting changes");

        const reintegrating = yield* transition(conflicted, {
          type: "agent-run.start-integration",
          runId: id("root"),
          targetThreadId: thread("target"),
          occurredAt: later,
        });
        expect(reintegrating.runs.get(id("root"))?.failure).toBeUndefined();
        const integrated = yield* transition(reintegrating, {
          type: "agent-run.succeed-integration",
          runId: id("root"),
          occurredAt: later,
        });
        expect(integrated.runs.get(id("root"))?.status).toBe("integrated");
        expect(integrated.runs.get(id("root"))?.failure).toBeUndefined();
      }),
  );

  it.effect("is replay deterministic", () =>
    Effect.gen(function* () {
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
        const next = yield* decide(state, command);
        events.push(...next);
        state = evolveAll(state, next);
      }
      expect(evolveAll(emptyAgentRunState(), events)).toEqual(state);
    }),
  );
});
