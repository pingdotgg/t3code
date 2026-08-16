import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  OrchestrationV2ThreadShellSnapshot,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";
import * as WorktreeRevivalService from "./WorktreeRevivalService.ts";
import { layer as worktreeServiceLayer, WorktreeService } from "./WorktreeService.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-worktree-service-v2-test-",
});
const serverConfigLiveLayer = serverConfigLayer.pipe(Layer.provide(NodeServices.layer));
const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(serverConfigLiveLayer),
  Layer.provideMerge(NodeServices.layer),
);
const worktreeLifecycleLayer = WorktreeLifecycle.layer;

const projectA = ProjectId.make("project-worktree-v2-a");
const projectB = ProjectId.make("project-worktree-v2-b");

const makeProject = (id: ProjectId, workspaceRoot: string): Project =>
  ({
    id,
    title: id === projectA ? "Project A" : "Project B",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  }) as Project;

const makeShell = (input: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly settledOverride: "settled" | "active" | null;
  readonly updatedAt: DateTime.Utc;
}): OrchestrationV2ThreadShell =>
  ({
    id: input.id,
    projectId: input.projectId,
    title: `${input.projectId} thread`,
    branch: "feature/shared",
    worktreePath: input.worktreePath,
    updatedAt: input.updatedAt,
    archivedAt: null,
    settledOverride: input.settledOverride,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;

const makeTestLayer = (
  projects: () => ReadonlyArray<Project>,
  shells: () => OrchestrationV2ThreadShell[],
  gitDriver?: GitVcsDriver.GitVcsDriver["Service"],
) => {
  const selectedGitLayer =
    gitDriver === undefined ? gitLayer : Layer.succeed(GitVcsDriver.GitVcsDriver, gitDriver);
  const projectLayer = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.none()),
    snapshot: Effect.sync(() => ({
      projects: [...projects()],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  });
  const revivalLayer = WorktreeRevivalService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        selectedGitLayer,
        serverConfigLiveLayer,
        NodeServices.layer,
        projectLayer,
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" }),
        }),
        worktreeLifecycleLayer,
      ),
    ),
  );
  return worktreeServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        selectedGitLayer,
        serverConfigLiveLayer,
        NodeServices.layer,
        projectLayer,
        revivalLayer,
        worktreeLifecycleLayer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [...shells()],
              archivedThreads: [],
            } as OrchestrationV2ThreadShellSnapshot),
        }),
      ),
    ),
  );
};

it.effect("rechecks unpublished commits immediately before pruning a worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;

    const repositoryRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-worktree-v2-prune-race-repo-",
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.init",
      cwd: repositoryRoot,
      args: ["init", "-b", "main"],
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.userEmail",
      cwd: repositoryRoot,
      args: ["config", "user.email", "test@example.com"],
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.userName",
      cwd: repositoryRoot,
      args: ["config", "user.name", "T3 Test"],
    });
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.add",
      cwd: repositoryRoot,
      args: ["add", "README.md"],
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.commit",
      cwd: repositoryRoot,
      args: ["commit", "-m", "initial"],
    });

    const worktreePath = path.join(config.worktreesDir, "orphan", "prune-race");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/prune-race",
      path: worktreePath,
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.addOrigin",
      cwd: repositoryRoot,
      args: ["remote", "add", "origin", repositoryRoot],
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.createUpstream",
      cwd: repositoryRoot,
      args: [
        "update-ref",
        "refs/remotes/origin/feature/prune-race",
        "refs/heads/feature/prune-race",
      ],
    });
    yield* driver.execute({
      operation: "WorktreeServicePruneRaceTest.trackUpstream",
      cwd: repositoryRoot,
      args: ["branch", "--set-upstream-to=origin/feature/prune-race", "feature/prune-race"],
    });

    let worktreeStatusChecks = 0;
    const racingDriver = GitVcsDriver.GitVcsDriver.of({
      ...driver,
      statusDetailsLocal: (cwd) => {
        if (cwd !== worktreePath) return driver.statusDetailsLocal(cwd);
        worktreeStatusChecks += 1;
        if (worktreeStatusChecks !== 2) return driver.statusDetailsLocal(cwd);
        return Effect.gen(function* () {
          yield* driver.execute({
            operation: "WorktreeServicePruneRaceTest.lateCommit",
            cwd: worktreePath,
            args: ["commit", "--allow-empty", "-m", "late unpublished change"],
          });
          return yield* driver.statusDetailsLocal(cwd);
        });
      },
    });
    const layer = makeTestLayer(
      () => [makeProject(projectA, repositoryRoot)],
      () => [],
      racingDriver,
    );

    const result = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.pruneWorktrees({ paths: [worktreePath] });
    }).pipe(Effect.provide(layer));

    assert.equal(worktreeStatusChecks, 2);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skipped, [{ path: worktreePath, reason: "unpushed" }]);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("rechecks thread linkage immediately before pruning a worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;

    const repositoryRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-worktree-v2-prune-link-race-repo-",
    });
    yield* driver.execute({
      operation: "WorktreeServiceLinkRaceTest.init",
      cwd: repositoryRoot,
      args: ["init", "-b", "main"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceLinkRaceTest.userEmail",
      cwd: repositoryRoot,
      args: ["config", "user.email", "test@example.com"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceLinkRaceTest.userName",
      cwd: repositoryRoot,
      args: ["config", "user.name", "T3 Test"],
    });
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* driver.execute({
      operation: "WorktreeServiceLinkRaceTest.add",
      cwd: repositoryRoot,
      args: ["add", "README.md"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceLinkRaceTest.commit",
      cwd: repositoryRoot,
      args: ["commit", "-m", "initial"],
    });

    const worktreePath = path.join(config.worktreesDir, "orphan", "link-race");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/link-race",
      path: worktreePath,
    });

    // First snapshot (inventory) sees no threads; the recheck taken right
    // before removal sees a thread that linked to the worktree in between.
    let snapshotCalls = 0;
    const shells = () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return [];
      return [
        makeShell({
          id: ThreadId.make("thread-late-link"),
          projectId: projectA,
          worktreePath,
          settledOverride: "active",
          updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        }),
      ];
    };
    const layer = makeTestLayer(() => [makeProject(projectA, repositoryRoot)], shells, driver);

    const result = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.pruneWorktrees({ paths: [worktreePath] });
    }).pipe(Effect.provide(layer));

    assert.isAtLeast(snapshotCalls, 2);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skipped, [{ path: worktreePath, reason: "active_thread" }]);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("combines thread safety across nested projects in the same repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;

    const repositoryRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-worktree-v2-nested-repo-",
    });
    yield* driver.execute({
      operation: "WorktreeServiceNestedTest.init",
      cwd: repositoryRoot,
      args: ["init", "-b", "main"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceNestedTest.userEmail",
      cwd: repositoryRoot,
      args: ["config", "user.email", "test@example.com"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceNestedTest.userName",
      cwd: repositoryRoot,
      args: ["config", "user.name", "T3 Test"],
    });
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* driver.execute({
      operation: "WorktreeServiceNestedTest.add",
      cwd: repositoryRoot,
      args: ["add", "README.md"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceNestedTest.commit",
      cwd: repositoryRoot,
      args: ["commit", "-m", "initial"],
    });

    const nestedProjectRoot = path.join(repositoryRoot, "packages", "nested");
    yield* fs.makeDirectory(nestedProjectRoot, { recursive: true });
    const worktreePath = path.join(config.worktreesDir, "nested", "active");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/nested-active",
      path: worktreePath,
    });

    const activeThread = makeShell({
      id: ThreadId.make("thread-worktree-v2-nested-active"),
      projectId: projectA,
      worktreePath,
      settledOverride: "active",
      updatedAt: DateTime.makeUnsafe("2026-01-05T00:00:00.000Z"),
    });
    const layer = makeTestLayer(
      () => [makeProject(projectA, nestedProjectRoot), makeProject(projectB, repositoryRoot)],
      () => [activeThread],
    );

    const inventory = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.listWorktrees({});
    }).pipe(Effect.provide(layer));

    assert.equal(inventory.worktrees.length, 1);
    const worktree = inventory.worktrees[0];
    assert.isDefined(worktree);
    assert.deepEqual(
      worktree?.projects.map((project) => project.workspaceRoot),
      [nestedProjectRoot, repositoryRoot],
    );
    assert.deepEqual(
      worktree?.threads.map((thread) => thread.threadId),
      [activeThread.id],
    );
    assert.isFalse(worktree?.safeToPrune);
    assert.deepEqual(worktree?.pruneBlockers, ["active_thread"]);

    const filteredInventory = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.listWorktrees({ projectId: projectB });
    }).pipe(Effect.provide(layer));
    assert.equal(filteredInventory.worktrees.length, 1);
    assert.deepEqual(
      filteredInventory.worktrees[0]?.threads.map((thread) => thread.threadId),
      [activeThread.id],
    );
    assert.isFalse(filteredInventory.worktrees[0]?.safeToPrune);

    const pruneResult = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.pruneWorktrees({ paths: [worktreePath] });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(pruneResult.removed, []);
    assert.deepEqual(pruneResult.skipped, [{ path: worktreePath, reason: "active_thread" }]);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);

it.effect("fails inventory when a repository worktree listing fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-worktree-v2-invalid-repo-",
    });
    const layer = makeTestLayer(
      () => [makeProject(projectA, workspaceRoot)],
      () => [],
    );

    const error = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.listWorktrees({});
    }).pipe(Effect.provide(layer), Effect.flip);

    assert.equal(error._tag, "WorktreeInventoryError");
    if (error._tag !== "WorktreeInventoryError") {
      return assert.fail(`Expected WorktreeInventoryError, received ${error._tag}`);
    }
    assert.equal(error.stage, "inspect_repository");
    assert.equal(error.workspaceRoot, workspaceRoot);
    assert.equal(error.message, "Failed to inspect a repository for the worktree inventory.");
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);
