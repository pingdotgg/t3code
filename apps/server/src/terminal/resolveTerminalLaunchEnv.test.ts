import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { LaunchEnv } from "../launchEnv/Services/LaunchEnv.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalSessionLookupError } from "./Services/Manager.ts";
import {
  resolveTerminalOpenInput,
  resolveTerminalRestartInput,
} from "./resolveTerminalLaunchEnv.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = "2026-01-01T00:00:00.000Z";
const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const makeProject = (): OrchestrationProject => ({
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: DEFAULT_MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/repo/worktrees/a",
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeTestLayer = (threadOption: Option.Option<OrchestrationThreadShell>) =>
  LaunchEnv.layerTest("/tmp/t3-resolve-terminal-launch-env").pipe(
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: (projectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(makeProject()) : Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.die("unused"),
        getFullThreadDiffContext: () => Effect.die("unused"),
        getThreadShellById: (threadId) =>
          Effect.succeed(threadId === THREAD_ID ? threadOption : Option.none()),
        getThreadDetailById: () => Effect.die("unused"),
      }),
    ),
  );

describe("resolveTerminalLaunchEnv", () => {
  it.effect("resolves launch env for open using the thread project id", () =>
    Effect.gen(function* () {
      const result = yield* resolveTerminalOpenInput({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/repo/worktrees/a",
      }).pipe(Effect.provide(makeTestLayer(Option.some(makeThread()))));

      assert.deepStrictEqual(result.env, {
        T3CODE_HOME: "/tmp/t3-resolve-terminal-launch-env",
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_PROJECT_ID: "project-1",
        T3CODE_THREAD_ID: "thread-1",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
      });
      assert.strictEqual(result.worktreePath, "/repo/worktrees/a");
      assert.isFalse("projectId" in result);
    }),
  );

  it.effect("fails when the thread is not found", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveTerminalOpenInput({
          threadId: THREAD_ID,
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/repo/worktrees/a",
        }).pipe(Effect.provide(makeTestLayer(Option.none()))),
      );

      assert.instanceOf(error, TerminalSessionLookupError);
    }),
  );

  it.effect("resolves launch env for restart using the thread project id", () =>
    Effect.gen(function* () {
      const result = yield* resolveTerminalRestartInput({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/repo/project",
        cols: 120,
        rows: 40,
      }).pipe(Effect.provide(makeTestLayer(Option.some(makeThread({ worktreePath: null })))));

      assert.strictEqual(result.env.T3CODE_PROJECT_ID, "project-1");
    }),
  );
});
