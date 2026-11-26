import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicyDocument,
  type ProjectTrackedFolder,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { layerThreadWorktreeRestore, ThreadWorktreeRestore } from "./restoreMissingWorktree.ts";
import * as TaskFolders from "./TaskFolders.ts";
import {
  approveLayoutCommands,
  layerTaskFoldersWithGit,
  taskFoldersTestProjectId as projectId,
  type TaskFoldersTestState,
} from "./TaskFolders.testkit.ts";

const layerFor = (state: TaskFoldersTestState, policy?: ManagedPolicyDocument) => {
  const base = GitVcsDriver.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-restore-worktree-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const workflow = Layer.unwrap(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return Layer.mock(GitWorkflowService.GitWorkflowService)({
        createWorktree: git.createWorktree,
        pruneWorktrees: git.pruneWorktrees,
        listLocalBranchNames: git.listLocalBranchNames,
      });
    }),
  );
  const settings = ServerSettings.layerTest(
    {},
    policy === undefined
      ? undefined
      : {
          organization: policy.organization,
          lockedSettings: [],
          ...(policy.limits?.maxRuntimeMode === undefined
            ? {}
            : { limits: { maxRuntimeMode: policy.limits.maxRuntimeMode } }),
        },
  );
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeedSome({ id: projectId, workspaceRoot: state.workspaceRoot } as never),
  });
  return layerThreadWorktreeRestore.pipe(
    Layer.provideMerge(layerTaskFoldersWithGit(state, policy)),
    Layer.provideMerge(workflow),
    Layer.provideMerge(settings),
    Layer.provideMerge(projects),
    Layer.provideMerge(base),
  );
};

const withState = <A, E>(
  test: (
    state: TaskFoldersTestState,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>> | Scope.Scope>,
  policy?: ManagedPolicyDocument,
) => {
  const state: TaskFoldersTestState = { workspaceRoot: "/unset", trackedFolders: [], thread: null };
  return test(state).pipe(Effect.provide(layerFor(state, policy)), Effect.scoped);
};

const tracked = (...folders: ReadonlyArray<string>): ReadonlyArray<ProjectTrackedFolder> =>
  folders.map((folder) => ({ path: folder, name: folder.split(/[\\/]/).at(-1)! }));

const setupLayoutRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-layout-" }),
  );
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "restore-worktree-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const shop = path.join(tmp, "shop");
  const api = path.join(shop, "api");
  yield* fileSystem.makeDirectory(api, { recursive: true });
  yield* run(api, "init", "-b", "main");
  yield* run(api, "config", "user.email", "troy@greendale.edu");
  yield* run(api, "config", "user.name", "Troy Barnes");
  yield* fileSystem.writeFileString(path.join(api, "README.md"), "greendale\n");
  yield* run(api, "add", ".");
  yield* run(api, "commit", "-m", "initial");
  const marker = path.join(tmp, "layout-ran");
  yield* fileSystem.writeFileString(
    path.join(shop, "t3.json"),
    JSON.stringify({
      worktreeLayout: {
        create: `echo ran >> "${marker}" && mkdir -p "$T3_WORKTREE_PROJECT_PATH" && (git -C "$T3_PROJECT_ROOT/api" worktree add -q "$T3_WORKTREE_PROJECT_PATH/api" "$T3_WORKTREE_BRANCH" 2>/dev/null || git -C "$T3_PROJECT_ROOT/api" worktree add -q -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH/api")`,
      },
    }),
  );
  return { fileSystem, path, run, shop, api, marker };
});

it.live(
  "skips worktreeLayout.create when an approval-required or plan agent restores a missing task folder",
  () =>
    withState((state) =>
      Effect.gen(function* () {
        const { fileSystem, path, run, shop, api, marker } = yield* setupLayoutRepo;
        state.workspaceRoot = shop;
        state.trackedFolders = tracked(api);
        yield* approveLayoutCommands;

        const taskFolders = yield* TaskFolders.TaskFolders;
        const plan = yield* taskFolders.plan({ projectId });
        assert.isNotNull(plan);
        const { taskFolder } = yield* taskFolders.create({
          plan: plan!,
          branch: "feature",
          projectStart: { refName: "main", baseRefName: "main" },
          startFromOrigin: false,
          projectCommands: "permitted",
        });
        assert.equal(yield* fileSystem.readFileString(marker), "ran\n");
        yield* fileSystem.remove(marker);

        const apiWorktree = path.join(taskFolder.root, "api");
        const restoreService = yield* ThreadWorktreeRestore;

        for (const modes of [
          { runtimeMode: "approval-required" as const, interactionMode: "default" as const },
          { runtimeMode: "full-access" as const, interactionMode: "plan" as const },
        ]) {
          yield* fileSystem.remove(apiWorktree, { recursive: true });
          yield* run(api, "worktree", "prune");
          yield* restoreService.restore(
            {
              id: ThreadId.make("thread:agent-restore"),
              projectId,
              worktreePath: taskFolder.projectPath,
              branch: "feature",
              ...modes,
            },
            { createdBy: "agent" },
          );
          assert.isFalse(yield* fileSystem.exists(marker));
          assert.isTrue(yield* fileSystem.exists(path.join(apiWorktree, "README.md")));
        }

        // A full-access agent in default mode with no ceiling still runs the approved layout command.
        yield* fileSystem.remove(apiWorktree, { recursive: true });
        yield* run(api, "worktree", "prune");
        yield* restoreService.restore(
          {
            id: ThreadId.make("thread:agent-restore"),
            projectId,
            worktreePath: taskFolder.projectPath,
            branch: "feature",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          { createdBy: "agent" },
        );
        assert.equal(yield* fileSystem.readFileString(marker), "ran\n");
      }),
    ),
);

it.live(
  "skips worktreeLayout.create when thread runtimeMode exceeds managedPolicy maxRuntimeMode",
  () =>
    withState(
      (state) =>
        Effect.gen(function* () {
          const { fileSystem, path, run, shop, api, marker } = yield* setupLayoutRepo;
          state.workspaceRoot = shop;
          state.trackedFolders = tracked(api);
          yield* approveLayoutCommands;

          const taskFolders = yield* TaskFolders.TaskFolders;
          const plan = yield* taskFolders.plan({ projectId });
          assert.isNotNull(plan);
          const { taskFolder } = yield* taskFolders.create({
            plan: plan!,
            branch: "feature",
            projectStart: { refName: "main", baseRefName: "main" },
            startFromOrigin: false,
            projectCommands: "permitted",
          });
          yield* fileSystem.remove(marker);

          const apiWorktree = path.join(taskFolder.root, "api");
          const restoreService = yield* ThreadWorktreeRestore;
          for (const createdBy of ["agent", "user"] as const) {
            yield* fileSystem.remove(apiWorktree, { recursive: true });
            yield* run(api, "worktree", "prune");
            yield* restoreService.restore(
              {
                id: ThreadId.make("thread:ceiling-restore"),
                projectId,
                worktreePath: taskFolder.projectPath,
                branch: "feature",
                runtimeMode: "full-access",
                interactionMode: "default",
              },
              { createdBy },
            );
            assert.isFalse(yield* fileSystem.exists(marker));
            assert.isTrue(yield* fileSystem.exists(path.join(apiWorktree, "README.md")));
          }
        }),
      {
        schemaVersion: 1,
        organization: "Greendale",
        limits: { maxRuntimeMode: "approval-required" },
      },
    ),
);
