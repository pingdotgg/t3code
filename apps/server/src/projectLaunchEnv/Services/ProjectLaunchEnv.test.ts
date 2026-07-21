import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectLaunchEnvLive } from "../Layers/ProjectLaunchEnvLive.ts";
import { ProjectLaunchEnvThreadLookupError } from "../Services/ProjectLaunchEnvErrors.ts";
import { ProjectLaunchEnv } from "../Services/ProjectLaunchEnv.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const T3_HOME = "/tmp/t3-project-launch-env";
const NOW = "2026-01-01T00:00:00.000Z";
const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const makeProject = (): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
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

const makeProjectionSnapshotQueryLayer = (threads: ReadonlyArray<OrchestrationThreadShell>) => {
  const projects = [makeProject()];
  return Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === projectId))),
  } as unknown as ProjectionSnapshotQueryShape);
};

const makeTestLayer = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
  ProjectLaunchEnvLive.pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), T3_HOME)),
    Layer.provide(makeProjectionSnapshotQueryLayer(threads)),
    Layer.provide(NodeServices.layer),
  );

describe("ProjectLaunchEnv.resolveForThread", () => {
  it.effect("resolves launch env using the thread project id", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
      });

      assert.deepStrictEqual(result.env, {
        T3CODE_HOME: T3_HOME,
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_PROJECT_ID: "project-1",
        T3CODE_THREAD_ID: "thread-1",
        T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
      });
      assert.strictEqual(result.worktreePath, "/repo/worktrees/a");
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );

  it.effect("ignores client projectId when the thread already exists", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const spoofedProjectId = ProjectId.make("project-spoofed");
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        projectId: spoofedProjectId,
      });

      assert.strictEqual(result.env.T3CODE_PROJECT_ID, "project-1");
      assert.strictEqual(result.projectId, PROJECT_ID);
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );

  it.effect("resolves launch env for draft threads using client projectId", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        projectId: PROJECT_ID,
      });

      assert.strictEqual(result.env.T3CODE_PROJECT_ID, "project-1");
      assert.strictEqual(result.env.T3CODE_THREAD_ID, "thread-1");
    }).pipe(Effect.provide(makeTestLayer([]))),
  );

  it.effect("fails when the thread is not found and projectId is omitted", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const error = yield* Effect.flip(
        projectLaunchEnv.resolveForThread({
          threadId: THREAD_ID,
          terminalId: DEFAULT_TERMINAL_ID,
        }),
      );

      assert.instanceOf(error, ProjectLaunchEnvThreadLookupError);
    }).pipe(Effect.provide(makeTestLayer([]))),
  );

  it.effect("prefers explicit worktreePath over the thread default", () =>
    Effect.gen(function* () {
      const projectLaunchEnv = yield* ProjectLaunchEnv;
      const result = yield* projectLaunchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        worktreePath: "/repo/worktrees/b",
      });

      assert.strictEqual(result.worktreePath, "/repo/worktrees/b");
      assert.strictEqual(result.env.T3CODE_WORKTREE_PATH, "/repo/worktrees/b");
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );
});
