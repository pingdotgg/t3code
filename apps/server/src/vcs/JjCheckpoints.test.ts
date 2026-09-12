import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import type * as JjVcsDriver from "./JjVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import {
  changeId,
  commitId,
  describeJj,
  jjOut,
  read,
  runGit,
  runJj,
  withJjRepo,
  write,
} from "./testing/JjTestSupport.ts";

const threadId = ThreadId.make("thread-jj-checkpoints");
const baselineRef = checkpointRefForThreadTurn(threadId, 0);
const firstTurnRef = checkpointRefForThreadTurn(threadId, 1);
const missingRef = checkpointRefForThreadTurn(threadId, 99);

function requireCheckpoints(driver: JjVcsDriver.JjVcsDriverShape): VcsDriver.VcsCheckpointOps {
  const checkpoints = driver.checkpoints;
  if (!checkpoints) {
    assert.fail("The Jujutsu driver exposes no checkpoint operations.");
  }
  return checkpoints;
}

interface RepoContext {
  readonly checkpoints: VcsDriver.VcsCheckpointOps;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** Scoped temp directory holding the repository, so sibling workspaces cannot collide. */
  readonly base: string;
  readonly root: string;
}

const withRepo = <A, E>(
  use: (context: RepoContext) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-checkpoints-" }, (repo) =>
    use({ ...repo, checkpoints: requireCheckpoints(repo.driver) }),
  );

describeJj("JjCheckpoints capture", () => {
  it.effect("pins the working-copy commit without moving @, a bookmark, or a head", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* runJj(context.root, ["bookmark", "create", "feature", "-r", "@-"]);
        yield* write(context, "a.txt", "v2\n");

        const changeBefore = yield* changeId(context.root, "@");
        const bookmarksBefore = yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]);

        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });

        assert.isTrue(
          yield* context.checkpoints.hasCheckpointRef({
            cwd: context.root,
            checkpointRef: baselineRef,
          }),
        );
        assert.equal(yield* changeId(context.root, "@"), changeBefore);
        assert.equal(
          yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]),
          bookmarksBefore,
        );
        assert.equal(
          yield* commitId(context.root, "@"),
          yield* runGit(context.root, ["rev-parse", baselineRef]).pipe(
            Effect.map((stdout) => stdout.trim()),
          ),
        );
      }),
    ),
  );

  it.effect("writes the ref into the main workspace's Git store from a secondary workspace", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        const secondary = context.path.join(context.base, "ws2");
        yield* runJj(context.root, ["workspace", "add", secondary]);
        yield* context.fileSystem.writeFileString(
          context.path.join(secondary, "b.txt"),
          "secondary\n",
        );

        yield* context.checkpoints.captureCheckpoint({
          cwd: secondary,
          checkpointRef: firstTurnRef,
        });

        assert.equal(
          yield* runGit(context.root, ["rev-parse", firstTurnRef]).pipe(
            Effect.map((stdout) => stdout.trim()),
          ),
          yield* commitId(secondary, "@"),
        );
      }),
    ),
  );

  it.effect("leaves a file above jj's snapshot limit out of the checkpoint and on disk", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "small.txt", "v1\n");
        yield* write(context, "big.txt", "x".repeat(2 * 1024 * 1024));

        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });

        const trackedPaths = yield* runGit(context.root, [
          "ls-tree",
          "--name-only",
          "-r",
          baselineRef,
        ]);
        assert.notInclude(trackedPaths, "big.txt");
        assert.include(trackedPaths, "small.txt");

        yield* write(context, "small.txt", "v2\n");
        assert.isTrue(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: baselineRef,
          }),
        );

        assert.equal(yield* read(context, "small.txt"), "v1\n");
        assert.isTrue(yield* context.fileSystem.exists(context.path.join(context.root, "big.txt")));
      }),
    ),
  );
});

describeJj("JjCheckpoints restore", () => {
  it.effect("restores contents while preserving the change, description, and every bookmark", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* runJj(context.root, ["bookmark", "create", "feature", "-r", "@-"]);
        yield* runJj(context.root, ["describe", "-m", "work in progress"]);
        yield* write(context, "a.txt", "v2\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });

        const secondary = context.path.join(context.base, "ws2");
        yield* runJj(context.root, ["workspace", "add", secondary]);
        const secondaryBefore = yield* commitId(secondary, "@");
        const changeBefore = yield* changeId(context.root, "@");
        const bookmarksBefore = yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]);

        yield* write(context, "a.txt", "v3\n");
        assert.isTrue(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: firstTurnRef,
          }),
        );

        assert.equal(yield* read(context, "a.txt"), "v2\n");
        assert.equal(yield* changeId(context.root, "@"), changeBefore);
        assert.equal(
          yield* jjOut(context.root, ["log", "-r", "@", "--no-graph", "-T", "description"]),
          "work in progress",
        );
        assert.equal(
          yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]),
          bookmarksBefore,
        );
        assert.equal(yield* commitId(secondary, "@"), secondaryBefore);
      }),
    ),
  );

  it.effect("falls back to @-, not @, when the checkpoint ref is missing", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* write(context, "a.txt", "v2\n");

        assert.isTrue(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: missingRef,
            fallbackToHead: true,
          }),
        );

        assert.equal(yield* read(context, "a.txt"), "v1\n");
      }),
    ),
  );

  it.effect("returns false for a missing ref, with and without the head fallback", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* write(context, "b.txt", "v1\n");

        assert.isFalse(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: missingRef,
          }),
        );
        // In a repository with no commits the fallback has no `@-` to resolve either.
        assert.isFalse(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: missingRef,
            fallbackToHead: true,
          }),
        );

        const entries = yield* context.fileSystem.readDirectory(context.root);
        assert.includeMembers([...entries], ["a.txt", "b.txt"]);
        assert.equal(yield* read(context, "a.txt"), "v1\n");
      }),
    ),
  );

  it.effect("recovers a checkpoint jj's own index has lost, leaving no bookmark behind", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* write(context, "a.txt", "v2\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });

        // A commit git still holds but jj cannot name is what an abandoned operation log or an
        // expired `jj util gc` leaves behind; a fresh object with the checkpoint's tree is the
        // deterministic stand-in.
        const captured = yield* commitId(context.root, "@");
        const orphan = yield* runGit(context.root, [
          "-c",
          "user.name=T3 Code Test",
          "-c",
          "user.email=t3code-test@example.com",
          "commit-tree",
          `${captured}^{tree}`,
          "-p",
          `${captured}^`,
          "-m",
          "checkpoint",
        ]).pipe(Effect.map((stdout) => stdout.trim()));
        yield* runGit(context.root, ["update-ref", firstTurnRef, orphan]);
        yield* write(context, "a.txt", "v3\n");
        assert.isTrue(
          yield* Effect.isFailure(
            runJj(context.root, ["log", "-r", orphan, "--no-graph", "-T", "commit_id"]),
          ),
        );

        assert.isTrue(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: firstTurnRef,
          }),
        );

        assert.equal(yield* read(context, "a.txt"), "v2\n");
        assert.notInclude(
          yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]),
          "t3-restore-",
        );
        assert.notInclude(
          yield* runGit(context.root, ["for-each-ref", "refs/heads"]),
          "t3-restore-",
        );
      }),
    ),
  );
});

describeJj("JjCheckpoints diff", () => {
  it.effect("renders two turns as numstat and as a patch the client parsers read", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        const renamedBody = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
        yield* write(context, "rename-old.txt", renamedBody);
        yield* write(context, "kept.txt", "v1\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });

        yield* context.fileSystem.rename(
          context.path.join(context.root, "rename-old.txt"),
          context.path.join(context.root, "rename-new.txt"),
        );
        yield* write(context, "kept.txt", "v2\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });

        const numstat = yield* context.checkpoints.diffCheckpoints({
          cwd: context.root,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: firstTurnRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        assert.deepStrictEqual(parseTurnDiffFilesFromNumstat(numstat), [
          { path: "kept.txt", additions: 1, deletions: 1 },
          { path: "rename-new.txt", additions: 0, deletions: 0 },
        ]);

        const patch = yield* context.checkpoints.diffCheckpoints({
          cwd: context.root,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: firstTurnRef,
          ignoreWhitespace: false,
        });

        assert.isTrue(patch.startsWith("diff --git a/"));
        assert.include(patch, "--- a/kept.txt");
        assert.include(patch, "+++ b/kept.txt");
      }),
    ),
  );

  it.effect("diffs against the empty tree in a repository with no commits", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });

        const numstat = yield* context.checkpoints.diffCheckpoints({
          cwd: context.root,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: firstTurnRef,
          fallbackFromToHead: true,
          ignoreWhitespace: false,
          format: "numstat",
        });

        assert.deepStrictEqual(parseTurnDiffFilesFromNumstat(numstat), [
          { path: "a.txt", additions: 1, deletions: 0 },
        ]);
      }),
    ),
  );

  it.effect("fails without a fallback when an endpoint cannot be resolved", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });

        const error = yield* Effect.flip(
          context.checkpoints.diffCheckpoints({
            cwd: context.root,
            fromCheckpointRef: baselineRef,
            toCheckpointRef: firstTurnRef,
            ignoreWhitespace: false,
            format: "numstat",
          }),
        );

        assert.equal(error._tag, "VcsProcessExitError");
      }),
    ),
  );

  it.effect("excludes the conflict scaffolding of a conflicted endpoint", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "base\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        const baseCommit = yield* commitId(context.root, "@-");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });
        yield* write(context, "a.txt", "one\n");
        yield* runJj(context.root, ["commit", "-m", "one"]);
        const sideOne = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", baseCommit]);
        yield* write(context, "a.txt", "two\n");
        yield* runJj(context.root, ["commit", "-m", "two"]);
        const sideTwo = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", sideOne, sideTwo]);

        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });

        const numstat = yield* context.checkpoints.diffCheckpoints({
          cwd: context.root,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: firstTurnRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        assert.notInclude(numstat, ".jjconflict-");
        assert.notInclude(numstat, "JJ-CONFLICT-README");
        assert.deepStrictEqual(parseTurnDiffFilesFromNumstat(numstat), [
          { path: "a.txt", additions: 1, deletions: 1 },
        ]);
      }),
    ),
  );
});

describeJj("JjCheckpoints delete", () => {
  it.effect("removes captured refs and tolerates missing ones", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });

        yield* context.checkpoints.deleteCheckpointRefs({
          cwd: context.root,
          checkpointRefs: [baselineRef, missingRef],
        });

        assert.isFalse(
          yield* context.checkpoints.hasCheckpointRef({
            cwd: context.root,
            checkpointRef: baselineRef,
          }),
        );
      }),
    ),
  );
});
