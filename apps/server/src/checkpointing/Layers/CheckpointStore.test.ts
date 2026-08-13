import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@t3tools/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
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
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "CheckpointStore.test.git",
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
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

function buildOversizedSingleLine(): string {
  return `${"x".repeat(11_000_000)}\n`;
}

function buildNumberedLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index)}`)
    .join("\n")
    .concat("\n");
}

function replaceLine(contents: string, lineIndex: number, replacement: string): string {
  const lines = contents.split("\n");
  lines[lineIndex] = replacement;
  return lines.join("\n");
}

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("checkpointRefMatchesWorkspace", () => {
    it.effect("rejects a baseline after the same worktree switches branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-branch-switch"),
          0,
        );

        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* writeTextFile(path.join(tmp, "feature.md"), "feature\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "feature"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        yield* git(tmp, ["checkout", "-b", "replacement", "HEAD^"]);

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );

    it.effect("rejects a baseline when dirty workspace contents change without moving HEAD", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-dirty-workspace"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# dirty\n");
        yield* writeTextFile(path.join(tmp, "untracked.md"), "untracked\n");

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );

    it.effect("rejects a baseline when only the staged workspace contents change", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-staged-workspace"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");

        expect(
          yield* checkpointStore.checkpointRefMatchesWorkspace({
            cwd: tmp,
            checkpointRef,
          }),
        ).toBe(false);
      }),
    );
  });

  describe("restoreCheckpoint", () => {
    it.effect("restores staged, unstaged, and untracked workspace state separately", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-restore-staging"),
          0,
        );

        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# unstaged\n");
        yield* writeTextFile(path.join(tmp, "untracked.md"), "untracked\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["clean", "-fd"]);

        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);
        expect(yield* git(tmp, ["show", ":README.md"])).toBe("# staged");
        expect(yield* fileSystem.readFileString(path.join(tmp, "README.md"))).toBe("# unstaged\n");
        expect(yield* fileSystem.readFileString(path.join(tmp, "untracked.md"))).toBe(
          "untracked\n",
        );
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("excludes base movement that entered the workspace during the turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-base-movement");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Another branch advances the base while the turn is running.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // The turn commits its own work, then rebases onto the advanced base.
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
      }),
    );

    it.effect("keeps turn-authored commits that a stacked branch forked from mid-turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-stacked");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);

        // A branch forked from an intermediate turn commit does not contain the
        // turn's final commit, so reachability alone would read the commit it
        // points at as the base the turn started from.
        yield* git(tmp, ["branch", "stacked-branch"]);

        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);

        // Real base movement, so the reflog gate cannot mask the ref exclusions.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).not.toContain("+foreign change");
        expect(diff).toContain("+turn change");
        expect(diff).toContain("+earlier change");
      }),
    );

    it.effect("keeps earlier turns' commits out of a diff whose base was rebased", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-rebased-base");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        // The thread already carries a committed earlier turn, so the rebase
        // rewrites thread history and the old base leaves the new base's chain.
        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "earlier turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["rebase", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
        expect(diff).not.toContain("+earlier change");
      }),
    );

    it.effect("keeps turn-authored commits that a mid-turn push left a remote ref on", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-pushed");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Real base movement, so the reflog gate cannot mask the ref exclusions.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);

        const pushedContents = replaceLine(
          replaceLine(buildNumberedLines(30), 1, "foreign change"),
          5,
          "pushed change",
        );
        yield* writeTextFile(sharedPath, pushedContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);
        // A mid-turn push leaves the branch's remote-tracking ref on the turn's
        // own commit; that must not be read as the base the turn started from.
        const pushedCommit = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["update-ref", "refs/remotes/origin/thread-branch", pushedCommit]);

        yield* writeTextFile(sharedPath, replaceLine(pushedContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).not.toContain("+foreign change");
        expect(diff).toContain("+turn change");
        expect(diff).toContain("+pushed change");
      }),
    );

    it.effect("excludes a base the turn merged in mid-turn", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-merge");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);

        // A merge keeps the turn's history as its first parent, so the adopted
        // base is only reachable through the merge's second parent.
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "turn commit"]);
        yield* git(tmp, ["merge", "--no-edit", "other-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).not.toContain("+foreign change");
      }),
    );

    it.effect("ignores base movement from a later turn when diffing an earlier one", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const sharedPath = path.join(tmp, "shared.md");
        yield* writeTextFile(sharedPath, buildNumberedLines(30));
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add shared"]);
        const baseBranch = yield* git(tmp, ["rev-parse", "--abbrev-ref", "HEAD"]);

        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-later-turn");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

        yield* git(tmp, ["checkout", "-b", "thread-branch"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });

        // Turn 2 moves no base; a stacked branch forks between its commits.
        const earlierContents = replaceLine(buildNumberedLines(30), 5, "earlier change");
        yield* writeTextFile(sharedPath, earlierContents);
        yield* git(tmp, ["commit", "-am", "first turn commit"]);
        yield* git(tmp, ["branch", "stacked-branch"]);
        yield* writeTextFile(sharedPath, replaceLine(earlierContents, 25, "turn change"));
        yield* git(tmp, ["commit", "-am", "second turn commit"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        // Turn 3 rebases. Diffing turn 2 afterwards must not see that rebase.
        yield* git(tmp, ["checkout", "-b", "other-branch", baseBranch]);
        yield* writeTextFile(sharedPath, replaceLine(buildNumberedLines(30), 1, "foreign change"));
        yield* git(tmp, ["commit", "-am", "foreign commit"]);
        yield* git(tmp, ["checkout", "thread-branch"]);
        yield* git(tmp, ["rebase", "other-branch"]);

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("+turn change");
        expect(diff).toContain("+earlier change");
      }),
    );

    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("limits checkpoint diffs to validated repo-relative paths", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-paths");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");
        yield* writeTextFile(path.join(tmp, "other.md"), "# other\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          paths: ["README.md", ":!other.md", "../outside.md"],
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
        expect(diff).not.toContain("other.md");
      }),
    );
  });

  describe("diffCheckpointFiles", () => {
    it.effect(
      "returns file summaries for checkpoint diffs whose patch exceeds the output limit",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.make("thread-checkpoint-store-large-file-summary");
          const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
          const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: fromCheckpointRef,
          });
          yield* writeTextFile(path.join(tmp, "README.md"), buildOversizedSingleLine());
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: toCheckpointRef,
          });

          const files = yield* checkpointStore.diffCheckpointFiles({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
          });

          expect(files).toEqual([{ path: "README.md", additions: 1, deletions: 1 }]);
        }),
    );
  });
});
