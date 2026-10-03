import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  ProjectId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";
import * as WorktreeRevivalService from "./WorktreeRevivalService.ts";
import * as WorktreeService from "./WorktreeService.ts";

export const projectId = ProjectId.make("project-worktrees");

export const makeProject = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Worktrees",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * The real service over real Git, with the projects, threads and terminals it
 * reads held in `state` so a test can change them between calls.
 */
export const makeHarness = () => {
  const state = {
    projects: [] as OrchestrationProjectShell[],
    threads: [] as OrchestrationV2ThreadShell[],
    publishTerminals: (_event: TerminalMetadataStreamEvent): Effect.Effect<void> => Effect.void,
    /** Runs on every thread read, so a test can tell a sweep has begun. */
    onThreadsRead: Effect.void as Effect.Effect<void>,
    /** Runs before Git removes a worktree, so a test can hold a removal open. */
    beforeGitRemove: Effect.void as Effect.Effect<void>,
    /** Runs after each removal. */
    onRemoved: Effect.void as Effect.Effect<void>,
  };
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-worktree-service-test-",
  }).pipe(Layer.provide(NodeServices.layer));
  const dependencies = Layer.mergeAll(
    serverConfigLayer,
    SqlitePersistenceMemory,
    WorktreeLifecycle.layer,
    Layer.mock(GitManager.GitManager)({
      invalidateStatus: () => Effect.suspend(() => state.onRemoved),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: (options) =>
        Effect.sync(() =>
          state.projects.filter(
            (project) =>
              options?.projectIds === undefined || options.projectIds.includes(project.id),
          ),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: (options) =>
        Effect.suspend(() => state.onThreadsRead).pipe(
          Effect.map(() => {
            const threads = state.threads.filter(
              (thread) =>
                options?.location === undefined ||
                (options.location === "archive") === (thread.archivedAt !== null),
            );
            return {
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: threads.filter((thread) => thread.archivedAt === null),
              archivedThreads: threads.filter((thread) => thread.archivedAt !== null),
            };
          }),
        ),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      subscribeMetadata: (listener) =>
        Effect.sync(() => {
          state.publishTerminals = listener;
          return () => undefined;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.sync(() =>
          Option.fromNullishOr(state.projects.find((project) => project.id === id)).pipe(
            Option.map((project) => ({ ...project, deletedAt: null })),
          ),
        ),
      snapshot: Effect.sync(() => ({
        projects: state.projects.map((project) => ({ ...project, deletedAt: null })),
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" }),
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        GitVcsDriver.GitVcsDriver,
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          return GitVcsDriver.GitVcsDriver.of({
            ...driver,
            removeWorktree: (input) =>
              Effect.suspend(() => state.beforeGitRemove).pipe(
                Effect.andThen(driver.removeWorktree(input)),
              ),
          });
        }),
      ).pipe(Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(serverConfigLayer)))),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const layer = Layer.mergeAll(WorktreeService.layer, WorktreeRevivalService.layer).pipe(
    Layer.provideMerge(dependencies),
  );
  return { state, layer };
};

/**
 * A repository whose primary remote is `upstream`, not `origin`, with its
 * default branch at the initial commit, and `.env` and `node_modules` ignored.
 */
export const initializeRepository = Effect.fn("WorktreeServiceTest.initializeRepository")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-service-repo-" }),
    );
    const run = (args: ReadonlyArray<string>) =>
      git.execute({ operation: "WorktreeServiceTest.git", cwd: repositoryRoot, args });
    yield* run(["init", "-b", "main"]);
    yield* run(["config", "user.email", "test@example.com"]);
    yield* run(["config", "user.name", "T3 Test"]);
    yield* fs.writeFileString(path.join(repositoryRoot, ".gitignore"), ".env\nnode_modules\n");
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* run(["add", "."]);
    yield* run(["commit", "-m", "initial"]);
    yield* run(["remote", "add", "upstream", repositoryRoot]);
    yield* run(["update-ref", "refs/remotes/upstream/main", "refs/heads/main"]);
    yield* run(["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main"]);
    return repositoryRoot;
  },
);

export const addWorktree = Effect.fn("WorktreeServiceTest.addWorktree")(function* (
  repositoryRoot: string,
  name: string,
  options: { readonly detached?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const worktreePath = path.join(yield* fs.realPath(config.worktreesDir), name);
  yield* git.execute({
    operation: "WorktreeServiceTest.addWorktree",
    cwd: repositoryRoot,
    args:
      options.detached === true
        ? ["worktree", "add", "--detach", worktreePath, "main"]
        : ["worktree", "add", "-b", `feature/${name}`, worktreePath, "main"],
  });
  return worktreePath;
});

export const commitIn = Effect.fn("WorktreeServiceTest.commitIn")(function* (worktreePath: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  yield* git.execute({
    operation: "WorktreeServiceTest.commit",
    cwd: worktreePath,
    args: ["commit", "--allow-empty", "-m", "local work"],
  });
  return (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha;
});
