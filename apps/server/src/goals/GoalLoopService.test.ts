import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  GOAL_CONTINUE_MESSAGE,
  GoalLoopService,
  canDriveGoalLoop,
  layer,
  layerWith,
  planGoalLoop,
  scanGoalSignal,
} from "./GoalLoopService.ts";

const NOW = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");
const threadId = ThreadId.make("thread-goal-loop");
const projectId = ProjectId.make("project-goal-loop");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-test" };

function goalLoop(input: Partial<ThreadGoalLoop> = {}): ThreadGoalLoop {
  return {
    state: "running",
    mode: "t3",
    iterations: 1,
    maxIterations: 3,
    updatedAt: NOW,
    ...input,
  };
}

const emptyProjection = {
  subagents: [],
  runs: [],
  messages: [],
};

it("uses the last goal status tag in the assistant response", () => {
  expect(scanGoalSignal("<goal_complete>\n<goal_blocked>Need access</goal_blocked>")).toEqual({
    kind: "blocked",
    reason: "Need access",
  });
});

it("continues an unfinished completed iteration", () => {
  expect(
    planGoalLoop(
      { goalLoop: goalLoop() },
      {
        ...emptyProjection,
        runs: [{ id: "run-1", ordinal: 1, requestedAt: NOW, status: "completed" }],
        messages: [{ role: "assistant", runId: "run-1", text: "Still working" }],
      },
    ),
  ).toEqual({ type: "send", advance: true, key: "run-1" });
});

it("stops when the agent completes or blocks the goal", () => {
  const projection = {
    ...emptyProjection,
    runs: [{ id: "run-1", ordinal: 1, requestedAt: NOW, status: "completed" }],
  };
  expect(
    planGoalLoop(
      { goalLoop: goalLoop() },
      {
        ...projection,
        messages: [{ role: "assistant", runId: "run-1", text: "Done <goal_complete>" }],
      },
    ),
  ).toEqual({ type: "update", state: "completed", key: "run-1" });
  expect(
    planGoalLoop(
      { goalLoop: goalLoop() },
      {
        ...projection,
        messages: [
          {
            role: "assistant",
            runId: "run-1",
            text: "<goal_blocked>Waiting for credentials</goal_blocked>",
          },
        ],
      },
    ),
  ).toEqual({
    type: "update",
    state: "blocked",
    key: "run-1",
    reason: "Waiting for credentials",
  });
});

it("caps the loop after its configured iteration limit", () => {
  expect(
    planGoalLoop(
      { goalLoop: goalLoop({ iterations: 3 }) },
      {
        ...emptyProjection,
        runs: [{ id: "run-3", ordinal: 3, requestedAt: NOW, status: "completed" }],
        messages: [{ role: "assistant", runId: "run-3", text: "Not done" }],
      },
    ),
  ).toEqual({
    type: "update",
    state: "capped",
    key: "run-3",
    reason: "Reached 3 iterations.",
  });
});

it("holds settled, archived, blocked, and runtime-waiting threads", () => {
  const driveable = {
    goal: "Ship it",
    goalLoop: goalLoop(),
    activeRunId: null,
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
  } as const;
  expect(canDriveGoalLoop(driveable)).toBe(true);
  expect(canDriveGoalLoop({ ...driveable, settledOverride: "settled" })).toBe(false);
  expect(canDriveGoalLoop({ ...driveable, settledAt: NOW })).toBe(false);
  expect(canDriveGoalLoop({ ...driveable, archivedAt: NOW })).toBe(false);
  expect(canDriveGoalLoop({ ...driveable, goalLoop: goalLoop({ state: "blocked" }) })).toBe(false);
  expect(canDriveGoalLoop({ ...driveable, pendingRuntimeRequest: { id: "request" } })).toBe(false);
});

function appThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Goal loop",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    goal: "Ship it",
    goalLoop: goalLoop(),
    deletedAt: null,
  };
}

function threadShell(): OrchestrationV2ThreadShell {
  return {
    ...appThread(),
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
  };
}

function threadProjection(): OrchestrationV2ThreadProjection {
  return {
    thread: appThread(),
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  };
}

it.effect("dispatches a recoverable continuation with native agent/server provenance", () => {
  const sent: ThreadManagement.ThreadManagementSendInput[] = [];
  const shell = threadShell();
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 1,
            threads: [shell],
            archivedThreads: [],
          }),
        getThreadProjection: () => Effect.succeed(threadProjection()),
        getThreadShell: () => Effect.succeed(shell),
        sendToThread: (input) => {
          sent.push(input);
          return Effect.die("stop after capture");
        },
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* GoalLoopService;
    yield* service.runDueWork;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: GOAL_CONTINUE_MESSAGE,
      createdBy: "agent",
      creationSource: "server",
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect(
  "pauses the goal with one row when continuation is switched off, until the owner resumes",
  () => {
    let on = false;
    let shell = threadShell();
    const sent: ThreadManagement.ThreadManagementSendInput[] = [];
    const dispatched: Array<Record<string, unknown>> = [];
    let projectionReads = 0;
    const testLayer = layerWith({ continueGoals: Effect.sync(() => on) }).pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [shell],
              archivedThreads: [],
            }),
          getThreadProjection: () =>
            Effect.sync(() => {
              projectionReads += 1;
              return threadProjection();
            }),
          getThreadShell: () => Effect.succeed(shell),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              // What the orchestrator does with the pause the loop asks for.
              if (command.type === "thread.goal.loop" && command.action === "sync") {
                shell = {
                  ...shell,
                  goalLoop: {
                    ...shell.goalLoop!,
                    state: command.state ?? shell.goalLoop!.state,
                    iterations: command.iterations ?? shell.goalLoop!.iterations,
                  },
                };
              }
              return {} as never;
            }),
          sendToThread: (input) => {
            sent.push(input);
            return Effect.die("stop after capture");
          },
        }),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* GoalLoopService;
      yield* service.runDueWork;
      expect(sent).toHaveLength(0);
      expect(dispatched).toMatchObject([
        {
          type: "thread.notice.record",
          notification: {
            summary: "Goal paused. T3 Code did not wake the agent (switched off in Settings)",
            detail: expect.stringContaining("resume the goal"),
          },
        },
        { type: "thread.goal.loop", action: "sync", state: "paused" },
      ]);
      expect(shell.goalLoop?.state).toBe("paused");

      // Paused loops are not visited, and switching back on starts nothing by itself.
      const reads = projectionReads;
      yield* service.runDueWork;
      on = true;
      yield* service.runDueWork;
      expect(projectionReads).toBe(reads);
      expect(dispatched).toHaveLength(2);
      expect(sent).toHaveLength(0);

      // The owner resumes: the loop is idle again and the next check continues it.
      shell = { ...shell, goalLoop: { ...shell.goalLoop!, state: "idle" } };
      yield* service.runDueWork;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ text: GOAL_CONTINUE_MESSAGE });
    }).pipe(Effect.provide(testLayer));
  },
);
