import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
) => {
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
        gitLayer,
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
        gitLayer,
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

it.effect("lists V2-managed worktrees and preserves shared project/thread references", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;

    const repositoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-v2-repo-" });
    yield* driver.execute({
      operation: "WorktreeServiceTest.init",
      cwd: repositoryRoot,
      args: ["init", "-b", "main"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.userEmail",
      cwd: repositoryRoot,
      args: ["config", "user.email", "test@example.com"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.userName",
      cwd: repositoryRoot,
      args: ["config", "user.name", "T3 Test"],
    });
    yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "hello\n");
    yield* driver.execute({
      operation: "WorktreeServiceTest.add",
      cwd: repositoryRoot,
      args: ["add", "README.md"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.commit",
      cwd: repositoryRoot,
      args: ["commit", "-m", "initial"],
    });

    const worktreePath = path.join(config.worktreesDir, "shared", "feature");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/shared",
      path: worktreePath,
    });
    const settledWorktreePath = path.join(config.worktreesDir, "shared", "settled");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/settled",
      path: settledWorktreePath,
    });
    const safeWorktreePath = path.join(config.worktreesDir, "orphan", "safe");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/safe",
      path: safeWorktreePath,
    });
    const unpushedWorktreePath = path.join(config.worktreesDir, "orphan", "unpushed");
    yield* driver.createWorktree({
      cwd: repositoryRoot,
      refName: "main",
      newRefName: "feature/unpushed",
      path: unpushedWorktreePath,
    });
    yield* fs.writeFileString(path.join(unpushedWorktreePath, "change.txt"), "unpublished\n");
    yield* driver.execute({
      operation: "WorktreeServiceTest.unpushedAdd",
      cwd: unpushedWorktreePath,
      args: ["add", "change.txt"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.unpushedCommit",
      cwd: unpushedWorktreePath,
      args: ["commit", "-m", "unpublished change"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.addOrigin",
      cwd: repositoryRoot,
      args: ["remote", "add", "origin", repositoryRoot],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.createGoneUpstream",
      cwd: repositoryRoot,
      args: ["update-ref", "refs/remotes/origin/feature/unpushed", "refs/heads/main"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.trackGoneUpstream",
      cwd: repositoryRoot,
      args: ["branch", "--set-upstream-to=origin/feature/unpushed", "feature/unpushed"],
    });
    yield* driver.execute({
      operation: "WorktreeServiceTest.deleteGoneUpstream",
      cwd: repositoryRoot,
      args: ["update-ref", "-d", "refs/remotes/origin/feature/unpushed"],
    });

    const worktreeAliasPath = path.join(repositoryRoot, "shared-worktree-alias");
    yield* fs.symlink(worktreePath, worktreeAliasPath);

    const threadA = makeShell({
      id: ThreadId.make("thread-worktree-v2-active"),
      projectId: projectA,
      worktreePath: worktreeAliasPath,
      settledOverride: "active",
      updatedAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
    });
    const threadB = makeShell({
      id: ThreadId.make("thread-worktree-v2-settled"),
      projectId: projectB,
      worktreePath,
      settledOverride: "settled",
      updatedAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
    });
    const settledThread = makeShell({
      id: ThreadId.make("thread-worktree-v2-settled-only"),
      projectId: projectA,
      worktreePath: settledWorktreePath,
      settledOverride: "settled",
      updatedAt: DateTime.makeUnsafe("2026-01-04T00:00:00.000Z"),
    });

    const layer = makeTestLayer(
      () => [makeProject(projectA, repositoryRoot), makeProject(projectB, repositoryRoot)],
      () => [threadA, threadB, settledThread],
    );
    const inventory = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.listWorktrees({});
    }).pipe(Effect.provide(layer));

    assert.equal(inventory.worktrees.length, 4);
    const worktree = inventory.worktrees.find((entry) => entry.branch === "feature/shared");
    const unpushedWorktree = inventory.worktrees.find(
      (entry) => entry.branch === "feature/unpushed",
    );
    const settledWorktree = inventory.worktrees.find((entry) => entry.branch === "feature/settled");
    assert.isDefined(worktree);
    assert.isDefined(unpushedWorktree);
    assert.isDefined(settledWorktree);
    assert.equal(worktree?.branch, "feature/shared");
    assert.equal(worktree?.projects.length, 2);
    assert.equal(worktree?.threads.length, 2);
    assert.isFalse(worktree?.orphaned);
    assert.isFalse(worktree?.safeToPrune);
    assert.deepEqual(worktree?.pruneBlockers, ["active_thread"]);
    assert.equal(worktree?.lastActivityAt, "2026-01-03T00:00:00.000Z");
    assert.isTrue(unpushedWorktree?.orphaned);
    assert.isFalse(unpushedWorktree?.dirty);
    assert.isTrue(unpushedWorktree?.upstreamGone);
    assert.equal(unpushedWorktree?.aheadOfDefaultCount, 1);
    assert.isFalse(unpushedWorktree?.safeToPrune);
    assert.deepEqual(unpushedWorktree?.pruneBlockers, ["unpushed"]);
    assert.isFalse(settledWorktree?.orphaned);
    assert.isTrue(settledWorktree?.safeToPrune);

    const staleDeletionCleanupRemoved = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.pruneOrphanedWorktree(settledWorktreePath);
    }).pipe(Effect.provide(layer));
    assert.isFalse(staleDeletionCleanupRemoved);
    assert.isTrue(yield* fs.exists(settledWorktreePath));

    const pruneResult = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.pruneWorktrees({
        paths: [
          safeWorktreePath,
          worktreePath,
          unpushedWorktreePath,
          path.join(config.worktreesDir, "unknown"),
        ],
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(pruneResult.removed, [
      { path: safeWorktreePath, workspaceRoot: repositoryRoot },
    ]);
    assert.deepEqual(
      pruneResult.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
      [
        { path: worktreePath, reason: "active_thread" },
        { path: unpushedWorktreePath, reason: "unpushed" },
        { path: path.join(config.worktreesDir, "unknown"), reason: "unknown_worktree" },
      ],
    );
    assert.isFalse(yield* fs.exists(safeWorktreePath));
    assert.equal(
      (yield* driver.execute({
        operation: "WorktreeServiceTest.branchStillExists",
        cwd: repositoryRoot,
        args: ["show-ref", "--verify", "--quiet", "refs/heads/feature/safe"],
      })).exitCode,
      0,
    );
    assert.isFalse(
      (yield* driver.listWorkspaces(repositoryRoot)).some(
        (entry) => entry.path === safeWorktreePath,
      ),
    );

    const reviveResult = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.reviveWorktree({
        workspaceRoot: repositoryRoot,
        worktreePath: safeWorktreePath,
        branch: "feature/safe",
      });
    }).pipe(Effect.provide(layer));
    assert.isTrue(reviveResult.revived);
    assert.isTrue(yield* fs.exists(safeWorktreePath));

    const secondReviveResult = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.reviveWorktree({
        workspaceRoot: repositoryRoot,
        worktreePath: safeWorktreePath,
        branch: "feature/safe",
      });
    }).pipe(Effect.provide(layer));
    assert.isFalse(secondReviveResult.revived);

    const occupiedPath = path.join(config.worktreesDir, "orphan", "occupied");
    yield* fs.makeDirectory(occupiedPath, { recursive: true });
    const occupiedReviveExit = yield* Effect.exit(
      Effect.gen(function* () {
        const service = yield* WorktreeService;
        return yield* service.reviveWorktree({
          workspaceRoot: repositoryRoot,
          worktreePath: occupiedPath,
          branch: "feature/safe",
        });
      }).pipe(Effect.provide(layer)),
    );
    assert.isTrue(Exit.isFailure(occupiedReviveExit));
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

    const pruneResult = yield* Effect.gen(function* () {
      const service = yield* WorktreeService;
      return yield* service.pruneWorktrees({ paths: [worktreePath] });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(pruneResult.removed, []);
    assert.deepEqual(pruneResult.skipped, [{ path: worktreePath, reason: "active_thread" }]);
    assert.isTrue(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(Layer.mergeAll(serverConfigLiveLayer, NodeServices.layer, gitLayer))),
);
