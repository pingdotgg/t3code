import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ThreadId, VcsProcessExitError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import { makeJjCheckpointOps } from "./JjCheckpoints.ts";
import type { VcsProcessInput } from "./VcsProcess.ts";
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
    Effect.gen(function* () {
      const repository = yield* repo.driver.detectRepository(repo.root);
      assert.isNotNull(repository);
      const handle = { kind: "jj" as const, repository: repository!, driver: repo.driver };
      // Detection is deliberately dormant at this prefix. Select the real jj driver at this seam;
      // checkpoint storage, command execution, and repository semantics remain production services.
      const checkpoints = yield* CheckpointStore.make.pipe(
        Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
          get: () => Effect.succeed(repo.driver),
          detect: () => Effect.succeed(handle),
          resolve: () => Effect.succeed(handle),
        }),
      );
      return yield* use({ ...repo, checkpoints });
    }),
  );

describeJj("JjCheckpoints capture", () => {
  it.effect("flushes the checkpoint ref when publishing into the colocated Git store", () =>
    withJjRepo({ prefix: "t3-jj-durable-checkpoint-", seed: true }, (context) =>
      Effect.gen(function* () {
        const commit = yield* commitId(context.root, "@");
        const commands: VcsProcessInput[] = [];
        const checkpoints = makeJjCheckpointOps({
          crypto: yield* Crypto.Crypto,
          process: {
            run: (input) => {
              commands.push(input);
              return context.process.run(input);
            },
          },
          ensureGitDir: () => Effect.succeed(context.path.join(context.root, ".git")),
          currentChange: () =>
            Effect.succeed({
              commitId: commit,
              parentCommitIds: [],
              description: "",
              empty: true,
              conflict: false,
              localBookmarks: [],
              fileStats: [],
            }),
        });
        yield* checkpoints.captureCheckpoint({ cwd: context.root, checkpointRef: baselineRef });
        const publish = commands.find((command) => command.args.includes("update-ref"));
        assert.isTrue(publish?.args.includes("core.fsync=objects,reference"));
        assert.isTrue(publish?.args.includes("core.fsyncMethod=fsync"));
        assert.equal((yield* runGit(context.root, ["rev-parse", baselineRef])).trim(), commit);
      }).pipe(Effect.provide(NodeCrypto.layer)),
    ),
  );

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
  for (const multipleFailures of [false, true]) {
    it.effect(
      multipleFailures
        ? "retains primary and all cleanup failures"
        : "surfaces a real Git ref-lock failure during recovery cleanup",
      () =>
        withJjRepo({ prefix: "t3-jj-cleanup-error-", seed: true }, (repo) =>
          Effect.gen(function* () {
            yield* write(repo, "saved.txt", "saved\n");
            const captured = yield* commitId(repo.root, "@");
            const orphan = (yield* runGit(repo.root, [
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              "commit-tree",
              `${captured}^{tree}`,
              "-p",
              `${captured}^`,
              "-m",
              "t3 checkpoint",
            ])).trim();
            yield* runGit(repo.root, ["update-ref", firstTurnRef, orphan]);
            yield* write(repo, "saved.txt", "changed\n");
            let tempRef = "";
            const checkpoints = makeJjCheckpointOps({
              crypto: yield* Crypto.Crypto,
              ensureGitDir: () => Effect.succeed(repo.path.join(repo.root, ".git")),
              currentChange: repo.driver.currentChange,
              process: {
                run: (input) =>
                  Effect.gen(function* () {
                    const updateIndex = input.args.indexOf("update-ref");
                    const ref = input.args[updateIndex + 1];
                    if (updateIndex !== -1 && ref?.startsWith("refs/heads/t3-restore-")) {
                      tempRef = ref;
                    }
                    const result = yield* repo.process.run(input);
                    if (
                      input.command === "jj" &&
                      input.args.includes("restore") &&
                      result.exitCode === 0
                    ) {
                      yield* repo.fileSystem
                        .writeFileString(repo.path.join(repo.root, ".git", `${tempRef}.lock`), "")
                        .pipe(Effect.orDie);
                      if (multipleFailures)
                        return yield* Effect.fail(
                          new VcsProcessExitError({
                            operation: input.operation,
                            command: "primary restore",
                            cwd: repo.root,
                            exitCode: 9,
                            detail: "primary restore failure",
                          }),
                        );
                    }
                    if (multipleFailures && input.args.includes("forget")) {
                      return yield* Effect.fail(
                        new VcsProcessExitError({
                          operation: input.operation,
                          command: "bookmark cleanup",
                          cwd: repo.root,
                          exitCode: 8,
                          detail: "bookmark cleanup failure",
                        }),
                      );
                    }
                    if (multipleFailures && input.args.includes("abandon")) {
                      return yield* Effect.fail(
                        new VcsProcessExitError({
                          operation: input.operation,
                          command: "abandon cleanup",
                          cwd: repo.root,
                          exitCode: 7,
                          detail: "abandon cleanup failure",
                        }),
                      );
                    }
                    return result;
                  }),
              },
            });
            const result = yield* checkpoints
              .restoreCheckpoint({ cwd: repo.root, checkpointRef: firstTurnRef })
              .pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(result));
            if (!Exit.isFailure(result)) return;
            const errors = result.cause.reasons.flatMap((reason) =>
              reason._tag === "Fail" ? [reason.error] : [],
            );
            assert.deepStrictEqual(
              errors.map((error) => error._tag),
              Array(multipleFailures ? 4 : 1).fill("VcsProcessExitError"),
            );
            if (multipleFailures) {
              assert.include(errors[0]!.message, "primary restore");
              assert.include(errors[1]!.message, "bookmark cleanup");
              assert.include(errors[3]!.message, "abandon cleanup");
            }
            assert.include(errors[multipleFailures ? 2 : 0]!.message, "exited with 1");
            assert.equal(yield* read(repo, "saved.txt"), "saved\n");
            assert.include(yield* runGit(repo.root, ["for-each-ref", "refs/heads"]), "t3-restore-");
            assert.notInclude(
              yield* jjOut(repo.root, ["log", "-r", "all()", "--no-graph", "-T", "commit_id"]),
              orphan,
            );
          }).pipe(Effect.provide(NodeCrypto.layer)),
        ),
    );
  }
  for (const interruptAfterImport of [false, true]) {
    it.effect(
      `cleans revived rewritten ancestors${interruptAfterImport ? " when interrupted at the import boundary" : ""}`,
      () =>
        withJjRepo({ prefix: "t3-jj-revived-", seed: true }, (repo) =>
          Effect.gen(function* () {
            yield* write(repo, "saved.txt", "saved\n");
            yield* runJj(repo.root, ["describe", "-m", "old parent"]);
            const hidden = yield* commitId(repo.root, "@");
            yield* runJj(repo.root, ["new", "-m", "working change"]);
            yield* runJj(repo.root, ["describe", "-r", "@-", "-m", "rewritten parent"]);
            const parent = yield* commitId(repo.root, "@-");
            const orphan = (yield* runGit(repo.root, [
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              "commit-tree",
              `${hidden}^{tree}`,
              "-p",
              hidden,
              "-m",
              "t3 checkpoint",
            ])).trim();
            yield* runGit(repo.root, ["update-ref", firstTurnRef, orphan]);
            yield* write(repo, "saved.txt", "changed\n");
            const before = yield* changeId(repo.root, "@");
            const checkpoints = makeJjCheckpointOps({
              crypto: yield* Crypto.Crypto,
              ensureGitDir: () => Effect.succeed(repo.path.join(repo.root, ".git")),
              currentChange: repo.driver.currentChange,
              process: {
                run: (input) =>
                  repo.process
                    .run(input)
                    .pipe(
                      Effect.flatMap((result) =>
                        interruptAfterImport &&
                        input.command === "jj" &&
                        input.args.includes("import")
                          ? Effect.interrupt
                          : Effect.succeed(result),
                      ),
                    ),
              },
            });
            const result = yield* checkpoints
              .restoreCheckpoint({
                cwd: repo.root,
                checkpointRef: firstTurnRef,
              })
              .pipe(Effect.exit);
            assert.equal(result._tag, interruptAfterImport ? "Failure" : "Success");
            assert.equal(yield* changeId(repo.root, "@"), before);
            assert.equal(yield* commitId(repo.root, "@-"), parent);
            assert.equal(
              yield* jjOut(repo.root, ["log", "-r", "@", "--no-graph", "-T", "description"]),
              "working change",
            );
            const visible = yield* jjOut(repo.root, [
              "log",
              "-r",
              "all()",
              "--no-graph",
              "-T",
              'commit_id ++ "\\n"',
            ]);
            assert.notInclude(visible, orphan);
            assert.notInclude(visible, hidden);
            assert.notInclude(
              yield* runGit(repo.root, ["for-each-ref", "refs/heads"]),
              "t3-restore-",
            );
            assert.notInclude(yield* jjOut(repo.root, ["bookmark", "list"]), "t3-restore-");
            assert.equal(
              yield* read(repo, "saved.txt"),
              interruptAfterImport ? "changed\n" : "saved\n",
            );
            if (Exit.isFailure(result)) {
              assert.isTrue(result.cause.reasons.some((reason) => reason._tag === "Interrupt"));
            }
          }).pipe(Effect.provide(NodeCrypto.layer)),
        ),
    );
  }
  it.effect("restores a captured merged tree without changing metadata", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "base.txt", "base\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        const base = yield* commitId(context.root, "@-");
        yield* write(context, "left.txt", "left\n");
        yield* runJj(context.root, ["commit", "-m", "left"]);
        const left = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", base]);
        yield* write(context, "right.txt", "right\n");
        yield* runJj(context.root, ["commit", "-m", "right"]);
        const right = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", left, right, "-m", "merge"]);
        const changeBefore = yield* changeId(context.root, "@");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });
        yield* write(context, "right.txt", "edited\n");
        yield* write(context, "turn.txt", "turn\n");
        assert.isTrue(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: baselineRef,
          }),
        );
        assert.equal(yield* read(context, "left.txt"), "left\n");
        assert.equal(yield* read(context, "right.txt"), "right\n");
        assert.isFalse(
          yield* context.fileSystem.exists(context.path.join(context.root, "turn.txt")),
        );
        assert.equal(yield* changeId(context.root, "@"), changeBefore);
        assert.equal(
          yield* jjOut(context.root, ["log", "-r", "@", "--no-graph", "-T", "description"]),
          "merge",
        );
      }),
    ),
  );

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

  it.effect("does not substitute a committed parent for a missing checkpoint", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* write(context, "a.txt", "v2\n");

        assert.isFalse(
          yield* context.checkpoints.restoreCheckpoint({
            cwd: context.root,
            checkpointRef: missingRef,
            fallbackToHead: true,
          }),
        );

        assert.equal(yield* read(context, "a.txt"), "v2\n");
      }),
    ),
  );

  it.effect("returns false for a missing ref in an unborn repository", () =>
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
          "t3 checkpoint",
        ]).pipe(Effect.map((stdout) => stdout.trim()));
        yield* runGit(context.root, ["update-ref", firstTurnRef, orphan]);
        yield* write(context, "a.txt", "v3\n");
        assert.isTrue(
          yield* Effect.isFailure(
            runJj(context.root, ["log", "-r", orphan, "--no-graph", "-T", "commit_id"]),
          ),
        );

        const changeBefore = yield* changeId(context.root, "@");
        const descriptionBefore = yield* jjOut(context.root, [
          "log",
          "-r",
          "@",
          "--no-graph",
          "-T",
          "description",
        ]);
        const bookmarksBefore = yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]);
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
          descriptionBefore,
        );
        assert.equal(
          yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]),
          bookmarksBefore,
        );
        assert.notInclude(
          yield* jjOut(context.root, ["bookmark", "list", "--all-remotes"]),
          "t3-restore-",
        );
        assert.notInclude(
          yield* runGit(context.root, ["for-each-ref", "refs/heads"]),
          "t3-restore-",
        );
        assert.notInclude(
          yield* jjOut(context.root, [
            "log",
            "-r",
            "all()",
            "--no-graph",
            "-T",
            'commit_id ++ "\\n"',
          ]),
          orphan,
        );
      }),
    ),
  );
});

describeJj("JjCheckpoints diff", () => {
  it.effect("diffs captured merge trees with rename pairs, not later working-copy edits", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "base.txt", "base\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        const base = yield* commitId(context.root, "@-");
        yield* write(context, "left.txt", "left\n");
        yield* runJj(context.root, ["commit", "-m", "left"]);
        const left = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", base]);
        yield* write(context, "right.txt", "right\n");
        yield* runJj(context.root, ["commit", "-m", "right"]);
        const right = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", left, right]);
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });
        yield* context.fileSystem.rename(
          context.path.join(context.root, "left.txt"),
          context.path.join(context.root, "renamed.txt"),
        );
        yield* write(context, "right.txt", "captured\n");
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: firstTurnRef,
        });
        yield* runJj(context.root, ["new", base]);
        yield* write(context, "later.txt", "not captured\n");
        const input = {
          cwd: context.root,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: firstTurnRef,
          ignoreWhitespace: false,
        };
        const patch = yield* context.checkpoints.diffCheckpoints(input);
        assert.include(patch, "-right");
        assert.include(patch, "+captured");
        assert.notInclude(patch, "later.txt");
        const numstat = yield* context.checkpoints.diffCheckpoints({ ...input, format: "numstat" });
        assert.deepStrictEqual(parseTurnDiffFilesFromNumstat(numstat), [
          { path: "renamed.txt", previousPath: "left.txt", additions: 0, deletions: 0 },
          { path: "right.txt", additions: 1, deletions: 1 },
        ]);
        assert.equal(
          yield* context.checkpoints.diffCheckpoints({ ...input, filePaths: ["base.txt"] }),
          "",
        );
        const missingBaseline = yield* context.checkpoints
          .diffCheckpoints({
            ...input,
            fromCheckpointRef: missingRef,
            fallbackFromToHead: true,
            format: "numstat",
          })
          .pipe(Effect.result);
        assert.equal(missingBaseline._tag, "Failure");
      }),
    ),
  );

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
          { path: "rename-new.txt", previousPath: "rename-old.txt", additions: 0, deletions: 0 },
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

  it.effect("diffs a captured empty tree in a repository with no commits", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* context.checkpoints.captureCheckpoint({
          cwd: context.root,
          checkpointRef: baselineRef,
        });
        yield* write(context, "a.txt", "v1\n");
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
          { path: "a.txt", additions: 1, deletions: 0 },
        ]);
      }),
    ),
  );

  it.effect("fails when a checkpoint endpoint cannot be resolved", () =>
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
            fallbackFromToHead: true,
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
