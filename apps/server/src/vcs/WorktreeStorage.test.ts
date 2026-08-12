import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeStorage from "./WorktreeStorage.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-worktree-storage-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-worktree-storage");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;
const now = "2026-08-12T00:00:00.000Z";

function makeProject(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: projectId,
    title: "Storage Test",
    workspaceRoot,
    defaultModelSelection: modelSelection,
    faviconPath: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeThread(
  id: string,
  worktreePath: string,
  lifecycle: "active" | "settled" | "archived" | "archived-live",
): OrchestrationThreadShell {
  const archived = lifecycle === "archived" || lifecycle === "archived-live";
  return {
    id: ThreadId.make(id),
    projectId,
    title: "Active worktree",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/active",
    worktreePath,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: archived ? now : null,
    settledOverride: lifecycle === "settled" ? "settled" : null,
    settledAt: lifecycle === "settled" ? now : null,
    session:
      lifecycle === "archived-live"
        ? {
            threadId: ThreadId.make(id),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          }
        : null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function emptySnapshot(): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [],
    updatedAt: now,
  };
}

function makeSnapshot(
  workspaceRoot: string,
  activeWorktreePath: string,
  settledWorktreePath: string,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [makeProject(workspaceRoot)],
    threads: [
      makeThread("thread-active-worktree", activeWorktreePath, "active"),
      makeThread("thread-settled-worktree", settledWorktreePath, "settled"),
    ],
    updatedAt: now,
  };
}

function projectionLayer(
  snapshot: OrchestrationShellSnapshot,
  archivedSnapshot: OrchestrationShellSnapshot = emptySnapshot(),
) {
  return Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getShellSnapshot: () => Effect.succeed(snapshot),
    getArchivedShellSnapshot: () => Effect.succeed(archivedSnapshot),
  });
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorktreeStorage.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

it.effect("previews status and only removes explicitly safe worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const repository = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-storage-repository-",
      });
      yield* driver.initRepo({ cwd: repository });
      yield* git(repository, ["config", "user.email", "test@test.com"]);
      yield* git(repository, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(repository, ".gitignore"), ".cache/\n");
      yield* fileSystem.writeFileString(path.join(repository, "README.md"), "# storage test\n");
      yield* git(repository, ["add", "."]);
      yield* git(repository, ["commit", "-m", "initial commit"]);

      const projectWorktreesRoot = path.join(config.worktreesDir, "storage-test");
      yield* fileSystem.makeDirectory(projectWorktreesRoot, { recursive: true });
      const activePath = path.join(projectWorktreesRoot, "active");
      const settledPath = path.join(projectWorktreesRoot, "settled");
      const cleanPath = path.join(projectWorktreesRoot, "clean");
      const dirtyPath = path.join(projectWorktreesRoot, "dirty");
      const newlyDirtyPath = path.join(projectWorktreesRoot, "newly-dirty");
      const archivedLivePath = path.join(projectWorktreesRoot, "archived-live");
      yield* git(repository, ["worktree", "add", "-b", "feature/active", activePath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/settled", settledPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/clean", cleanPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/dirty", dirtyPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/newly-dirty", newlyDirtyPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/archived-live", archivedLivePath]);
      yield* fileSystem.makeDirectory(path.join(cleanPath, ".cache"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cleanPath, ".cache", "artifact.bin"),
        "ignored build artifact",
      );
      yield* fileSystem.symlink(
        path.join(cleanPath, ".cache", "already-removed"),
        path.join(cleanPath, ".cache", "vanished-during-scan"),
      );
      yield* fileSystem.writeFileString(path.join(dirtyPath, "notes.txt"), "uncommitted\n");

      const snapshot = makeSnapshot(repository, activePath, settledPath);
      const archivedSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        projects: [makeProject(repository)],
        threads: [makeThread("thread-archived-live-worktree", archivedLivePath, "archived-live")],
        updatedAt: now,
      };
      const storage = yield* WorktreeStorage.make.pipe(
        Effect.provide(projectionLayer(snapshot, archivedSnapshot)),
      );
      const preview = yield* storage.preview();
      const previewProject = preview.projects[0];
      assert.isDefined(previewProject);
      assert.isAbove(preview.totalSizeBytes, 0);
      assert.deepStrictEqual(
        Object.fromEntries(
          previewProject.worktrees.map((worktree) => [worktree.refName, worktree.status]),
        ),
        {
          "feature/active": "active",
          "feature/archived-live": "active",
          "feature/clean": "clean",
          "feature/dirty": "dirty",
          "feature/newly-dirty": "clean",
          "feature/settled": "clean",
        },
      );

      yield* fileSystem.writeFileString(
        path.join(newlyDirtyPath, "appeared-after-preview.txt"),
        "do not remove\n",
      );
      const cleanCommit = yield* git(repository, ["rev-parse", "feature/clean"]);
      const settledCommit = yield* git(repository, ["rev-parse", "feature/settled"]);
      const dirtyCommit = yield* git(repository, ["rev-parse", "feature/dirty"]);
      const newlyDirtyCommit = yield* git(repository, ["rev-parse", "feature/newly-dirty"]);
      const firstCleanup = yield* storage.cleanup({
        targets: [
          { projectId, path: activePath },
          { projectId, path: archivedLivePath },
          { projectId, path: settledPath },
          { projectId, path: cleanPath },
          { projectId, path: dirtyPath },
          { projectId, path: newlyDirtyPath },
        ],
        confirmedDirtyPaths: [],
      });
      assert.deepStrictEqual(
        firstCleanup.outcomes.map((outcome) => outcome.status),
        [
          "skipped_active",
          "skipped_active",
          "removed",
          "removed",
          "skipped_dirty",
          "skipped_dirty",
        ],
      );
      assert.equal(yield* fileSystem.exists(activePath), true);
      assert.equal(yield* fileSystem.exists(archivedLivePath), true);
      assert.equal(yield* fileSystem.exists(settledPath), false);
      assert.equal(yield* fileSystem.exists(cleanPath), false);
      assert.equal(yield* fileSystem.exists(dirtyPath), true);
      assert.equal(yield* fileSystem.exists(newlyDirtyPath), true);
      assert.equal(yield* git(repository, ["rev-parse", "feature/clean"]), cleanCommit);
      assert.equal(yield* git(repository, ["rev-parse", "feature/settled"]), settledCommit);

      const confirmedCleanup = yield* storage.cleanup({
        targets: [{ projectId, path: dirtyPath }],
        confirmedDirtyPaths: [dirtyPath],
      });
      assert.equal(confirmedCleanup.outcomes[0]?.status, "removed");
      assert.equal(yield* fileSystem.exists(dirtyPath), false);
      assert.equal(yield* git(repository, ["rev-parse", "feature/dirty"]), dirtyCommit);
      assert.equal(yield* git(repository, ["rev-parse", "feature/newly-dirty"]), newlyDirtyCommit);
      assert.equal(yield* fileSystem.exists(activePath), true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("skips a worktree that becomes active before it is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const repository = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-storage-activate-during-cleanup-",
      });
      yield* driver.initRepo({ cwd: repository });
      yield* git(repository, ["config", "user.email", "test@test.com"]);
      yield* git(repository, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(repository, "README.md"), "# storage test\n");
      yield* git(repository, ["add", "."]);
      yield* git(repository, ["commit", "-m", "initial commit"]);

      const projectWorktreesRoot = path.join(config.worktreesDir, "storage-activate");
      yield* fileSystem.makeDirectory(projectWorktreesRoot, { recursive: true });
      const firstPath = path.join(projectWorktreesRoot, "first");
      const secondPath = path.join(projectWorktreesRoot, "second");
      yield* git(repository, ["worktree", "add", "-b", "feature/first", firstPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/second", secondPath]);

      const snapshotRef = yield* Ref.make(
        makeSnapshot(repository, path.join(projectWorktreesRoot, "unused"), firstPath),
      );
      const storage = yield* WorktreeStorage.make.pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
              getShellSnapshot: () => Ref.get(snapshotRef),
              getArchivedShellSnapshot: () => Effect.succeed(emptySnapshot()),
            }),
            Layer.succeed(GitVcsDriver.GitVcsDriver, {
              ...driver,
              removeWorktree: (input) =>
                Ref.update(snapshotRef, (snapshot) => ({
                  ...snapshot,
                  threads: [
                    ...snapshot.threads,
                    makeThread("thread-activated-during-cleanup", secondPath, "active"),
                  ],
                })).pipe(Effect.andThen(driver.removeWorktree(input))),
            }),
          ),
        ),
      );

      const cleanup = yield* storage.cleanup({
        targets: [
          { projectId, path: firstPath },
          { projectId, path: secondPath },
        ],
        confirmedDirtyPaths: [],
      });
      assert.deepStrictEqual(
        cleanup.outcomes.map((outcome) => outcome.status),
        ["removed", "skipped_active"],
      );
      assert.equal(yield* fileSystem.exists(firstPath), false);
      assert.equal(yield* fileSystem.exists(secondPath), true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("does not force-remove a worktree that becomes dirty after the status check", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const repository = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-storage-dirty-during-remove-",
      });
      yield* driver.initRepo({ cwd: repository });
      yield* git(repository, ["config", "user.email", "test@test.com"]);
      yield* git(repository, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(repository, ".gitignore"), ".cache/\n");
      yield* fileSystem.writeFileString(path.join(repository, "README.md"), "# storage test\n");
      yield* git(repository, ["add", "."]);
      yield* git(repository, ["commit", "-m", "initial commit"]);

      const projectWorktreesRoot = path.join(config.worktreesDir, "storage-dirty-race");
      yield* fileSystem.makeDirectory(projectWorktreesRoot, { recursive: true });
      const racePath = path.join(projectWorktreesRoot, "race");
      yield* git(repository, ["worktree", "add", "-b", "feature/race", racePath]);
      yield* fileSystem.makeDirectory(path.join(racePath, ".cache"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(racePath, ".cache", "artifact.bin"), "ignored\n");

      const snapshot = makeSnapshot(
        repository,
        path.join(projectWorktreesRoot, "unused"),
        racePath,
      );
      const storage = yield* WorktreeStorage.make.pipe(
        Effect.provide(
          Layer.merge(
            projectionLayer(snapshot),
            Layer.succeed(GitVcsDriver.GitVcsDriver, {
              ...driver,
              statusDetailsLocal: (cwd) =>
                driver
                  .statusDetailsLocal(cwd)
                  .pipe(
                    Effect.tap((status) =>
                      status.hasWorkingTreeChanges
                        ? Effect.void
                        : fileSystem
                            .writeFileString(
                              path.join(cwd, "appeared-after-status.txt"),
                              "do not delete\n",
                            )
                            .pipe(Effect.orDie),
                    ),
                  ),
            }),
          ),
        ),
      );

      const cleanup = yield* storage.cleanup({
        targets: [{ projectId, path: racePath }],
        confirmedDirtyPaths: [],
      });
      assert.equal(cleanup.outcomes[0]?.status, "skipped_dirty");
      assert.equal(yield* fileSystem.exists(racePath), true);
      assert.equal(
        yield* fileSystem.exists(path.join(racePath, "appeared-after-status.txt")),
        true,
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);
