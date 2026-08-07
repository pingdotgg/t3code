import {
  AgentProfileId,
  AgentProfileRevision,
  AgentProfileRef,
  AgentRunId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { AgentHookBlockedError } from "../AgentHookRunner.ts";
import type { AgentRun, AgentRunCommand, AgentRunEvent } from "./AgentRun.ts";
import type { AgentRunRepository } from "./AgentRunRepository.ts";
import {
  AgentTerminalHookPrerequisiteError,
  completeSuccessfulRun,
  hookWorkspaceForRun,
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
  startedAt: "2026-08-07T12:00:01.000Z",
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
