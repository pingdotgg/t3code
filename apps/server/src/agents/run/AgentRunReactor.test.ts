import {
  AgentProfileId,
  AgentProfileRevision,
  AgentProfileRef,
  AgentRunId,
  CommandId,
  EventId,
  ModelSelection,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as TestClock from "effect/testing/TestClock";

import { AgentHookBlockedError } from "../AgentHookRunner.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import type { AgentRun, AgentRunCommand, AgentRunEvent } from "./AgentRun.ts";
import type { AgentRunRepository } from "./AgentRunRepository.ts";
import {
  AgentTerminalHookPrerequisiteError,
  appendAgentRunTaskActivity,
  cancelledAgentRunRevision,
  completeSuccessfulRun,
  failedAgentRunRevision,
  hookWorkspaceForRun,
  loadAgentRunForProviderEvent,
  matchesActiveAgentRunTurn,
  shouldBindAgentRunTurn,
} from "./AgentRunReactor.ts";

const occurredAt = "2026-08-07T12:01:00.000Z";
const runId = AgentRunId.make("completion-run");
const run: AgentRun = {
  id: runId,
  profile: AgentProfileRef.make({
    id: AgentProfileId.make("completion-profile"),
    scope: "environment",
    revision: AgentProfileRevision.make("a".repeat(64)),
  }),
  budget: {
    maxRuns: 1,
    maxConcurrency: 1,
    maxDepth: 0,
    maxWallTimeMinutes: 10,
    maxTotalTokens: 1,
  },
  status: "running",
  revision: 2,
  childThreadId: ThreadId.make("completion-child"),
  parentRunId: null,
  rootRunId: runId,
  depth: 0,
  detached: false,
  parentThreadId: ThreadId.make("completion-parent"),
  projectId: ProjectId.make("completion-project"),
  modelSelection: ModelSelection.make({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  }),
  instanceId: ProviderInstanceId.make("codex"),
  workspaceMode: "shared",
  requestedAt: "2026-08-07T12:00:00.000Z",
  wallTimeOriginAt: "2026-08-07T12:00:00.000Z",
  startedAt: "2026-08-07T12:00:01.000Z",
  activeTurnId: TurnId.make("completion-turn"),
  finishedAt: null,
  updatedAt: "2026-08-07T12:00:01.000Z",
  usage: undefined,
  consumedTokens: 0,
  consumedEstimatedCostUsd: 0,
  failure: undefined,
  waitingForChildren: false,
  integrationTargetThreadId: null,
};

const repositoryFor = (dispatched: Array<AgentRunCommand>) =>
  ({
    listByLineage: () => Effect.succeed([run]),
    dispatch: (command: AgentRunCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return [] as ReadonlyArray<AgentRunEvent>;
      }),
  }) as unknown as AgentRunRepository["Service"];

it("fails closed when an isolated run has no child worktree", () => {
  const isolated = { ...run, workspaceMode: "isolated-worktree" as const };
  assert.equal(hookWorkspaceForRun(isolated, null, "/project"), null);
  assert.equal(
    hookWorkspaceForRun({ ...isolated, childThreadId: null }, "/child", "/project"),
    null,
  );
});

it("allows a shared run to use its project workspace when no child worktree exists", () => {
  assert.equal(hookWorkspaceForRun(run, null, "/project"), "/project");
});

it.effect("retains a provider event across a transient run lookup failure", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const repository = {
      getByChildThread: () =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new PersistenceSqlError({
                  operation: "AgentRunRepository.getByChildThread",
                  detail: "temporary database failure",
                }),
              )
            : Effect.succeed(Option.some(run));
        }),
    };

    const loaded = yield* loadAgentRunForProviderEvent(
      repository,
      ThreadId.make("completion-child"),
    ).pipe(Effect.retry(Schedule.recurs(1)));

    assert.equal(loaded?.id, run.id);
    assert.equal(attempts, 2);
  }),
);

it.effect("appends a deterministic parent task completion for a native Agent run", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    yield* appendAgentRunTaskActivity({
      engine: {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      },
      run: { ...run, revision: 3 },
      status: "completed",
      createdAt: occurredAt,
    });
    yield* appendAgentRunTaskActivity({
      engine: {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      },
      run: { ...run, revision: 7 },
      status: "running",
      createdAt: "2026-08-07T12:02:00.000Z",
    });

    assert.deepEqual(commands, [
      {
        type: "thread.activity.append",
        commandId: CommandId.make("agent-run:completion-run:3:completed"),
        threadId: ThreadId.make("completion-parent"),
        activity: {
          id: EventId.make("agent-run:completion-run:3:completed"),
          tone: "info",
          kind: "task.completed",
          summary: "Agent run completed",
          payload: {
            taskId: "completion-run",
            agentKind: "agent",
            model: "gpt-5",
            agentProfileId: "completion-profile",
            status: "completed",
          },
          turnId: null,
          createdAt: occurredAt,
        },
        createdAt: occurredAt,
      },
      {
        type: "thread.activity.append",
        commandId: CommandId.make("agent-run:completion-run:7:running"),
        threadId: ThreadId.make("completion-parent"),
        activity: {
          id: EventId.make("agent-run:completion-run:7:running"),
          tone: "info",
          kind: "task.updated",
          summary: "Agent run running",
          payload: {
            taskId: "completion-run",
            agentKind: "agent",
            model: "gpt-5",
            agentProfileId: "completion-profile",
            status: "running",
          },
          turnId: null,
          createdAt: "2026-08-07T12:02:00.000Z",
        },
        createdAt: "2026-08-07T12:02:00.000Z",
      },
    ]);
  }),
);

it.effect("keeps AgentRun lifecycle authoritative when its parent activity append fails", () =>
  Effect.gen(function* () {
    let appendAttempts = 0;
    yield* appendAgentRunTaskActivity({
      engine: {
        dispatch: () =>
          Effect.suspend(() => {
            appendAttempts += 1;
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: "thread.activity.append",
                detail: "parent thread is unavailable",
              }),
            );
          }),
      },
      run,
      status: "completed",
      createdAt: occurredAt,
    });

    assert.equal(appendAttempts, 1);
  }),
);

it.effect("keeps activity interruption from aborting authoritative AgentRun work", () =>
  Effect.gen(function* () {
    let continued = false;
    yield* appendAgentRunTaskActivity({
      engine: { dispatch: () => Effect.interrupt },
      run,
      status: "completed",
      createdAt: occurredAt,
    });
    continued = true;

    assert.isTrue(continued);
  }),
);

it("does not synthesize cancellation activity for a no-op terminal cancel", () => {
  assert.equal(cancelledAgentRunRevision(run, []), null);
});

it("uses only the persisted failure revision for the same Agent run", () => {
  const failed = {
    type: "agent-run.result-failed" as const,
    runId: run.id,
    revision: 9,
    occurredAt,
    failure: "Provider turn failed.",
  };

  assert.equal(failedAgentRunRevision(run, [failed]), 9);
  assert.equal(
    failedAgentRunRevision(run, [{ ...failed, runId: AgentRunId.make("different-run") }]),
    null,
  );
  assert.equal(cancelledAgentRunRevision(run, [failed]), null);
  assert.equal(failedAgentRunRevision(run, []), null);
});

it("ignores a terminal event from a prior follow-up turn and accepts the current turn", () => {
  const currentFollowUp = { ...run, activeTurnId: TurnId.make("follow-up-current") };

  assert.isFalse(
    matchesActiveAgentRunTurn(currentFollowUp, { turnId: TurnId.make("follow-up-prior") }),
  );
  assert.isFalse(matchesActiveAgentRunTurn(currentFollowUp, { turnId: undefined }));
  assert.isTrue(
    matchesActiveAgentRunTurn(currentFollowUp, { turnId: TurnId.make("follow-up-current") }),
  );
});

it("binds a current canonical turn.started event but rejects a stale prior turn", () => {
  const nextRevision = {
    ...run,
    activeTurnId: null,
    updatedAt: "2026-08-07T12:02:00.000Z",
  };

  assert.isFalse(
    shouldBindAgentRunTurn(nextRevision, {
      turnId: TurnId.make("prior-follow-up-turn"),
      createdAt: "2026-08-07T12:01:59.999Z",
    }),
  );
  assert.isTrue(
    shouldBindAgentRunTurn(nextRevision, {
      turnId: TurnId.make("current-follow-up-turn"),
      createdAt: "2026-08-07T12:02:00.000Z",
    }),
  );
});

it.effect("validates completion budgets before running afterResult hooks", () =>
  Effect.gen(function* () {
    const dispatched: Array<AgentRunCommand> = [];
    let hookRuns = 0;
    yield* completeSuccessfulRun({
      run,
      usage: { totalTokens: 2 },
      occurredAt,
      repository: repositoryFor(dispatched),
      afterResult: Effect.sync(() => {
        hookRuns += 1;
      }),
    });

    assert.equal(hookRuns, 0);
    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["agent-run.fail"],
    );
  }),
);

it.effect("keeps a blocking afterResult hook authoritative after preflight succeeds", () =>
  Effect.gen(function* () {
    const dispatched: Array<AgentRunCommand> = [];
    yield* completeSuccessfulRun({
      run,
      usage: { totalTokens: 1 },
      occurredAt,
      repository: repositoryFor(dispatched),
      afterResult: Effect.fail(
        new AgentHookBlockedError({
          stage: "afterResult",
          hookKind: "shell",
          category: "exit",
          detail: "Review hook rejected the result.",
          exitCode: 1,
          cause: { exitCode: 1 },
        }),
      ),
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["agent-run.fail"],
    );
    const failure = dispatched[0];
    assert.equal(failure?.type, "agent-run.fail");
    if (failure?.type === "agent-run.fail") {
      assert.equal(failure.failure, "Review hook rejected the result.");
    }
  }),
);

it.effect("retries terminal persistence without rerunning a successful afterResult hook", () =>
  Effect.gen(function* () {
    const dispatched: Array<AgentRunCommand> = [];
    let completionAttempts = 0;
    let hookRuns = 0;
    const repository = {
      ...repositoryFor(dispatched),
      dispatch: (command: AgentRunCommand) =>
        Effect.suspend(() => {
          if (command.type === "agent-run.succeed") {
            completionAttempts += 1;
            if (completionAttempts === 1) {
              return Effect.fail(
                new PersistenceSqlError({
                  operation: "AgentRunRepository.dispatch",
                  detail: "temporary database failure",
                }),
              );
            }
          }
          dispatched.push(command);
          return Effect.succeed([] as ReadonlyArray<AgentRunEvent>);
        }),
    } as unknown as AgentRunRepository["Service"];

    const completion = yield* completeSuccessfulRun({
      run,
      usage: { totalTokens: 1 },
      occurredAt,
      repository,
      afterResult: Effect.sync(() => {
        hookRuns += 1;
      }),
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(1));
    yield* Fiber.join(completion);

    assert.equal(hookRuns, 1);
    assert.equal(completionAttempts, 2);
    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["agent-run.succeed"],
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("fails completion when terminal hook prerequisites cannot be loaded", () =>
  Effect.gen(function* () {
    const dispatched: Array<AgentRunCommand> = [];
    yield* completeSuccessfulRun({
      run,
      usage: { totalTokens: 1 },
      occurredAt,
      repository: repositoryFor(dispatched),
      afterResult: Effect.fail(
        new AgentTerminalHookPrerequisiteError({
          stage: "afterResult",
          detail: "Could not load the pinned Agent profile snapshot.",
        }),
      ),
    });

    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["agent-run.fail"],
    );
    const failure = dispatched[0];
    assert.equal(failure?.type, "agent-run.fail");
    if (failure?.type === "agent-run.fail") {
      assert.equal(failure.failure, "Could not load the pinned Agent profile snapshot.");
    }
  }),
);
