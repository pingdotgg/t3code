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

import { LaunchEnvTestLayer } from "../Layers/LaunchEnvTest.ts";
import { LaunchEnvThreadLookupError } from "../Services/LaunchEnvErrors.ts";
import { LaunchEnv } from "../Services/LaunchEnv.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const T3_HOME = "/tmp/t3-launch-env";
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

const makeTestLayer = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
  LaunchEnvTestLayer.withFixtures({
    t3Home: T3_HOME,
    projects: [makeProject()],
    threads,
  });

describe("LaunchEnv.resolveForThread", () => {
  it.effect("resolves launch env using the thread project id", () =>
    Effect.gen(function* () {
      const launchEnv = yield* LaunchEnv;
      const result = yield* launchEnv.resolveForThread({
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
      const launchEnv = yield* LaunchEnv;
      const spoofedProjectId = ProjectId.make("project-spoofed");
      const result = yield* launchEnv.resolveForThread({
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
      const launchEnv = yield* LaunchEnv;
      const result = yield* launchEnv.resolveForThread({
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
      const launchEnv = yield* LaunchEnv;
      const error = yield* Effect.flip(
        launchEnv.resolveForThread({
          threadId: THREAD_ID,
          terminalId: DEFAULT_TERMINAL_ID,
        }),
      );

      assert.instanceOf(error, LaunchEnvThreadLookupError);
    }).pipe(Effect.provide(makeTestLayer([]))),
  );

  it.effect("prefers explicit worktreePath over the thread default", () =>
    Effect.gen(function* () {
      const launchEnv = yield* LaunchEnv;
      const result = yield* launchEnv.resolveForThread({
        threadId: THREAD_ID,
        terminalId: DEFAULT_TERMINAL_ID,
        worktreePath: "/repo/worktrees/b",
      });

      assert.strictEqual(result.worktreePath, "/repo/worktrees/b");
      assert.strictEqual(result.env.T3CODE_WORKTREE_PATH, "/repo/worktrees/b");
    }).pipe(Effect.provide(makeTestLayer([makeThread()]))),
  );
});
