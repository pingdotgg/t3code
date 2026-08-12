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
  lifecycle: "active" | "settled",
): OrchestrationThreadShell {
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
    archivedAt: null,
    settledOverride: lifecycle === "settled" ? "settled" : null,
    settledAt: lifecycle === "settled" ? now : null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
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
      yield* git(repository, ["worktree", "add", "-b", "feature/active", activePath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/settled", settledPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/clean", cleanPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/dirty", dirtyPath]);
      yield* git(repository, ["worktree", "add", "-b", "feature/newly-dirty", newlyDirtyPath]);
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
      const storage = yield* WorktreeStorage.make.pipe(
        Effect.provide(
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getShellSnapshot: () => Effect.succeed(snapshot),
          }),
        ),
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
          "feature/clean": "clean",
          "feature/dirty": "dirty",
          "feature/newly-dirty": "clean",
          "feature/settled": "clean",
        },
      );
      assert.equal(
        preview.reclaimableSizeBytes,
        previewProject.worktrees
          .filter((worktree) => worktree.status === "clean")
          .reduce((total, worktree) => total + worktree.sizeBytes, 0),
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
          { projectId, path: settledPath },
          { projectId, path: cleanPath },
          { projectId, path: dirtyPath },
          { projectId, path: newlyDirtyPath },
        ],
        confirmedDirtyPaths: [],
      });
      assert.deepStrictEqual(
        firstCleanup.outcomes.map((outcome) => outcome.status),
        ["skipped_active", "removed", "removed", "skipped_dirty", "skipped_dirty"],
      );
      assert.equal(yield* fileSystem.exists(activePath), true);
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
