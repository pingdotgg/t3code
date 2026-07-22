// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStore.layer", (it) => {
  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );

    it.effect("recognizes an owned Git repository through a symbolic path alias", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const repositoryPath = NodePath.join(tmp, "repository");
        const aliasPath = NodePath.join(tmp, "repository-alias");
        yield* fileSystem.makeDirectory(repositoryPath);
        yield* initRepoWithCommit(repositoryPath);
        yield* fileSystem.symlink(repositoryPath, aliasPath);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(aliasPath)).toBe(true);
      }),
    );

    it.effect("treats a standalone project nested under another repository as non-Git", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const project = NodePath.join(tmp, "project");
        yield* git(tmp, ["init"]);
        yield* fileSystem.makeDirectory(project);

        expect(yield* checkpointStore.isGitRepository(project)).toBe(false);
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("captures and restores an initialized repository before its first commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-unborn-git-test-");
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-unborn-git-checkpoint-store");
        const baselineRef = checkpointRefForThreadTurn(threadId, 0);
        const sourcePath = NodePath.join(tmp, "source.txt");

        yield* git(tmp, ["init"]);
        yield* writeTextFile(sourcePath, "before\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baselineRef });
        yield* writeTextFile(sourcePath, "after\n");

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: baselineRef,
          }),
        ).toBe(true);
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(sourcePath)).toBe("before\n");
      }),
    );

    it.effect("restores an empty checkpoint in a repository before its first commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-unborn-empty-test-");
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const baselineRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-unborn-empty-checkpoint-store"),
          0,
        );
        const createdPath = NodePath.join(tmp, "created.txt");
        const postCheckpointIgnorePath = NodePath.join(tmp, ".gitignore");
        const ignoredCreatedPath = NodePath.join(tmp, "state.cache");

        yield* git(tmp, ["init"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baselineRef });
        yield* writeTextFile(createdPath, "created after baseline\n");
        yield* writeTextFile(postCheckpointIgnorePath, "*.cache\n");
        yield* writeTextFile(ignoredCreatedPath, "ignored after baseline\n");

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: baselineRef,
          }),
        ).toBe(true);
        expect(yield* fileSystem.exists(createdPath)).toBe(false);
        expect(yield* fileSystem.exists(postCheckpointIgnorePath)).toBe(false);
        expect(yield* fileSystem.exists(ignoredCreatedPath)).toBe(false);
      }),
    );

    it.effect("preserves files ignored by the restored checkpoint", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-unborn-ignored-test-");
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const baselineRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-unborn-ignored-checkpoint-store"),
          0,
        );
        const ignorePath = NodePath.join(tmp, ".gitignore");
        const ignoredPath = NodePath.join(tmp, "local.cache");

        yield* git(tmp, ["init"]);
        yield* writeTextFile(ignorePath, "*.cache\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baselineRef });
        yield* writeTextFile(ignoredPath, "local-only data\n");

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: baselineRef,
          }),
        ).toBe(true);
        expect(yield* fileSystem.readFileString(ignorePath)).toBe("*.cache\n");
        expect(yield* fileSystem.readFileString(ignoredPath)).toBe("local-only data\n");
      }),
    );

    it.effect("uses shadow checkpoints for a project nested under an unrelated repository", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-nested-project-test-");
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const project = NodePath.join(tmp, "project");
        const threadId = ThreadId.make("thread-nested-project-checkpoint-store");
        const baselineRef = checkpointRefForThreadTurn(threadId, 0);
        const changedRef = checkpointRefForThreadTurn(threadId, 1);
        const createdPath = NodePath.join(project, "created.txt");

        yield* git(tmp, ["init"]);
        yield* fileSystem.makeDirectory(project);
        yield* checkpointStore.captureCheckpoint({ cwd: project, checkpointRef: baselineRef });
        yield* writeTextFile(createdPath, "created\n");
        yield* checkpointStore.captureCheckpoint({ cwd: project, checkpointRef: changedRef });

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: project,
            checkpointRef: baselineRef,
          }),
        ).toBe(true);
        expect(yield* fileSystem.exists(createdPath)).toBe(false);
        expect(yield* checkpointStore.isGitRepository(project)).toBe(false);
      }),
    );

    it.effect("captures and restores files without initializing Git in the workspace", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-shadow-test-");
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-shadow-checkpoint-store");
        const baselineRef = checkpointRefForThreadTurn(threadId, 0);
        const changedRef = checkpointRefForThreadTurn(threadId, 1);
        const sourcePath = NodePath.join(tmp, "source.txt");
        const createdPath = NodePath.join(tmp, "created.txt");

        yield* writeTextFile(sourcePath, "before\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baselineRef });
        yield* writeTextFile(sourcePath, "after\n");
        yield* writeTextFile(createdPath, "new\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: changedRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: changedRef,
          ignoreWhitespace: false,
        });
        expect(diff).toContain("+after");
        expect(diff).toContain("created.txt");

        expect(
          yield* checkpointStore.restoreCheckpoint({
            cwd: tmp,
            checkpointRef: baselineRef,
          }),
        ).toBe(true);
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(sourcePath)).toBe("before\n");
        expect(yield* fileSystem.exists(createdPath)).toBe(false);
        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("fails shadow checkpoint diffs when a ref is unavailable", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-shadow-invalid-ref-test-");
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-shadow-invalid-ref-checkpoint-store");
        const baselineRef = checkpointRefForThreadTurn(threadId, 0);
        const missingRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baselineRef });
        const error = yield* Effect.flip(
          checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef: baselineRef,
            toCheckpointRef: missingRef,
            ignoreWhitespace: false,
          }),
        );

        expect(error._tag).toBe("VcsProcessExitError");
        expect(error.message).toContain("git diff");
      }),
    );

    it.effect("surfaces corrupted shadow checkpoint refs instead of treating them as missing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-shadow-corrupt-ref-test-");
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-shadow-corrupt-ref-checkpoint-store"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        const shadowRepositoryPath = NodePath.join(
          config.stateDir,
          "checkpoints",
          NodeCrypto.createHash("sha256").update(NodePath.resolve(tmp)).digest("hex"),
        );
        yield* fileSystem.writeFileString(
          NodePath.join(shadowRepositoryPath, checkpointRef),
          "not-a-commit\n",
        );

        const error = yield* Effect.flip(
          checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef }),
        );
        expect(error._tag).toBe("VcsProcessExitError");
        expect(error.message).toContain("git for-each-ref");

        const captureError = yield* Effect.flip(
          checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef }),
        );
        expect(captureError._tag).toBe("VcsProcessExitError");
        expect(
          yield* Effect.flip(checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })),
        ).toMatchObject({ _tag: "VcsProcessExitError" });
      }),
    );

    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });
});
