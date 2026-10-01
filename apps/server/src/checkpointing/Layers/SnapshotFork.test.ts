import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { admitWorkspaceCommand } from "../../orchestration/workspaceAdmission.ts";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-snapshot-fork-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provide(GitCoreTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, CheckpointStoreTestLayer);

function makeTmpDir(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-fork-" });
  });
}

function git(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, unknown, GitCore> {
  return Effect.gen(function* () {
    const result = yield* (yield* GitCore).execute({ operation: "SnapshotFork.test", cwd, args });
    return result.stdout.trim();
  });
}

function write(filePath: string, contents: string) {
  return Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(filePath, contents));
}

/**
 * Failure modes owned by these real-repository tests:
 * - snapshot misses staged, unstaged, or untracked content;
 * - capture mutates HEAD, the real index, porcelain status, or stash;
 * - a clean source gains an unnecessary commit;
 * - ignored content or a registered nested worktree leaks into the child;
 * - the snapshot commit is not a direct child of the original HEAD.
 */
it.layer(TestLayer)("snapshot fork", (it) => {
  describe("createWorkspaceSnapshotCommit", () => {
    it.effect("captures all source changes without changing the source checkout", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const gitCore = yield* GitCore;
        yield* gitCore.initRepo({ cwd });
        yield* git(cwd, ["config", "user.name", "Snapshot Test"]);
        yield* git(cwd, ["config", "user.email", "snapshot@example.test"]);
        yield* write(path.join(cwd, "tracked.txt"), "base\n");
        yield* write(path.join(cwd, "staged.txt"), "base\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "base"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* write(path.join(cwd, "staged.txt"), "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        yield* write(path.join(cwd, "tracked.txt"), "unstaged\n");
        yield* write(path.join(cwd, "untracked.txt"), "untracked\n");
        yield* write(path.join(cwd, ".gitignore"), "ignored/\n");
        yield* git(cwd, ["add", ".gitignore"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(path.join(cwd, "ignored"));
        yield* write(path.join(cwd, "ignored", "placeholder"), "ignored\n");
        const nestedPath = path.join(cwd, "nested-worktree");
        yield* git(cwd, ["worktree", "add", "-b", "nested-snapshot-test", nestedPath, "HEAD"]);
        yield* write(path.join(nestedPath, "nested-only.txt"), "not part of this checkout\n");

        const status = yield* git(cwd, ["status", "--porcelain=2", "--untracked-files=all"]);
        const index = yield* git(cwd, ["ls-files", "-s"]);
        const checkpointStore = yield* CheckpointStore;
        const snapshot = yield* checkpointStore.createWorkspaceSnapshotCommit({ cwd });

        const snapshotCommit = snapshot;
        const project = {
          id: ProjectId.make("snapshot-project"),
          workspaceRoot: cwd,
        };
        const command = {
          type: "thread.create",
          commandId: CommandId.make("snapshot-create-command"),
          threadId: ThreadId.make("snapshot-create-thread"),
          projectId: project.id,
          title: "Snapshot child",
          modelSelection: {
            instanceId: ProviderInstanceId.make("snapshot-test-provider"),
            model: "test-model",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          sourceWorktreePath: cwd,
          createdAt: new Date().toISOString(),
        } as OrchestrationCommand;
        const admitted = yield* admitWorkspaceCommand(
          {
            findThread: () => undefined,
            findProject: () => project as never,
            claimOwnership: (input) =>
              Effect.succeed({
                canonicalPath: input.worktreePath,
                worktreePath: input.worktreePath,
                branch: input.branch,
                generation: 1,
              }),
            hasCleanupReservationByPath: () => Effect.succeed(false),
            createWorkspaceSnapshotCommit: (source) =>
              checkpointStore.createWorkspaceSnapshotCommit({ cwd: source }),
          },
          command,
        );
        const childPath = (admitted as { readonly worktreePath: string }).worktreePath;
        const childBranch = (admitted as { readonly branch: string }).branch;
        const childHead = yield* git(childPath, ["rev-parse", "HEAD"]);
        expect(yield* git(childPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(childBranch);
        expect(yield* git(cwd, ["rev-parse", `${snapshotCommit}^`])).toBe(head);
        expect(yield* git(childPath, ["rev-parse", "HEAD^"])).toBe(head);
        expect(yield* git(childPath, ["show", "HEAD:tracked.txt"])).toBe("unstaged");
        expect(yield* git(childPath, ["show", "HEAD:staged.txt"])).toBe("staged");
        expect(yield* git(childPath, ["show", "HEAD:untracked.txt"])).toBe("untracked");
        expect(yield* git(childPath, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(
          "ignored/placeholder",
        );
        expect(yield* git(childPath, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(
          "nested-worktree/nested-only.txt",
        );
        expect(yield* git(cwd, ["rev-parse", "HEAD"])).toBe(head);
        expect(yield* git(cwd, ["status", "--porcelain=2", "--untracked-files=all"])).toBe(status);
        expect(yield* git(cwd, ["ls-files", "-s"])).toBe(index);
        expect(yield* git(cwd, ["stash", "list"])).toBe("");

        const cleanSnapshot = yield* checkpointStore.createWorkspaceSnapshotCommit({
          cwd: childPath,
        });
        expect(cleanSnapshot).toBe(childHead);
      }),
    );

    it.effect("forks a clean source from HEAD without creating a commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const gitCore = yield* GitCore;
        yield* gitCore.initRepo({ cwd });
        yield* git(cwd, ["config", "user.name", "Snapshot Test"]);
        yield* git(cwd, ["config", "user.email", "snapshot@example.test"]);
        yield* write(path.join(cwd, "clean.txt"), "clean\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "clean source"]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        const checkpointStore = yield* CheckpointStore;
        const admitted = yield* admitWorkspaceCommand(
          {
            findThread: () => undefined,
            findProject: () =>
              ({ id: ProjectId.make("snapshot-clean-project"), workspaceRoot: cwd }) as never,
            claimOwnership: (input) =>
              Effect.succeed({
                canonicalPath: input.worktreePath,
                worktreePath: input.worktreePath,
                branch: input.branch,
                generation: 1,
              }),
            hasCleanupReservationByPath: () => Effect.succeed(false),
            createWorkspaceSnapshotCommit: (source) =>
              checkpointStore.createWorkspaceSnapshotCommit({ cwd: source }),
          },
          {
            type: "thread.create",
            commandId: CommandId.make("snapshot-clean-command"),
            threadId: ThreadId.make("snapshot-clean-thread"),
            projectId: ProjectId.make("snapshot-clean-project"),
            title: "Clean child",
            modelSelection: {
              instanceId: ProviderInstanceId.make("snapshot-clean-provider"),
              model: "test-model",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            sourceWorktreePath: cwd,
            createdAt: new Date().toISOString(),
          } as OrchestrationCommand,
        );
        const childPath = (admitted as { readonly worktreePath: string }).worktreePath;
        expect(yield* git(childPath, ["rev-parse", "HEAD"])).toBe(head);
        expect(yield* git(childPath, ["rev-list", "--count", "HEAD"])).toBe("1");
      }),
    );

    it.effect("fails child admission when snapshot capture fails instead of using HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const gitCore = yield* GitCore;
        yield* gitCore.initRepo({ cwd });
        yield* git(cwd, ["config", "user.name", "Snapshot Test"]);
        yield* git(cwd, ["config", "user.email", "snapshot@example.test"]);
        yield* write(path.join(cwd, "source.txt"), "source\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "source"]);
        const failure = yield* admitWorkspaceCommand(
          {
            findThread: () => undefined,
            findProject: () =>
              ({ id: ProjectId.make("snapshot-failure-project"), workspaceRoot: cwd }) as never,
            claimOwnership: () =>
              Effect.die("ownership must not be claimed after snapshot failure"),
            hasCleanupReservationByPath: () => Effect.succeed(false),
            createWorkspaceSnapshotCommit: () => Effect.fail(new Error("snapshot failed")),
          },
          {
            type: "thread.create",
            commandId: CommandId.make("snapshot-failure-command"),
            threadId: ThreadId.make("snapshot-failure-thread"),
            projectId: ProjectId.make("snapshot-failure-project"),
            title: "Failing child",
            modelSelection: {
              instanceId: ProviderInstanceId.make("snapshot-failure-provider"),
              model: "test-model",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            sourceWorktreePath: cwd,
            createdAt: new Date().toISOString(),
          } as OrchestrationCommand,
        ).pipe(Effect.flip);
        expect(failure.message).toContain("could not snapshot source worktree");
        expect(failure.message).toContain("snapshot failed");
      }),
    );
  });
});
