// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
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
  });

  describe("captureCheckpoint", () => {
    for (const scenario of [
      "partial staging",
      "staged deletion of ignored file",
      "staged addition removed from disk",
      "intent to add",
      "subdirectory",
      "unborn subdirectory",
      "missing index",
      "linked worktree",
      "assume unchanged",
      "skip worktree",
      "split index",
      "sparse checkout",
      "unmerged index",
    ]) {
      it.effect(`preserves snapshot and index semantics with ${scenario}`, () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const vcsProcess = yield* VcsProcess.VcsProcess;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          yield* initRepoWithCommit(tmp);
          yield* fileSystem.makeDirectory(NodePath.join(tmp, "inside"));
          yield* writeTextFile(NodePath.join(tmp, "inside", "file.txt"), "original\n");
          yield* writeTextFile(NodePath.join(tmp, "outside.txt"), "outside\n");
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "fixture"]);
          let cwd = tmp;
          let hasHead = true;
          if (scenario === "linked worktree") {
            cwd = NodePath.join(tmp, "linked");
            yield* git(tmp, ["worktree", "add", "-b", "linked", cwd]);
          }
          if (scenario === "unborn subdirectory") {
            cwd = yield* makeTmpDir();
            yield* git(cwd, ["init"]);
            yield* writeTextFile(NodePath.join(cwd, "outside.txt"), "staged outside\n");
            yield* git(cwd, ["add", "."]);
            yield* fileSystem.makeDirectory(NodePath.join(cwd, "inside"));
            yield* writeTextFile(NodePath.join(cwd, "inside", "file.txt"), "new inside\n");
            cwd = NodePath.join(cwd, "inside");
            hasHead = false;
          } else {
            const file = NodePath.join(cwd, "inside", "file.txt");
            yield* writeTextFile(file, "staged content\n");
            yield* git(cwd, ["add", "inside/file.txt"]);
            yield* writeTextFile(file, "working tree content\n");
            if (scenario === "staged deletion of ignored file") {
              yield* git(cwd, ["rm", "--cached", "-f", "inside/file.txt"]);
              yield* writeTextFile(NodePath.join(cwd, ".gitignore"), "inside/file.txt\n");
            } else if (scenario === "staged addition removed from disk") {
              yield* writeTextFile(NodePath.join(cwd, "new.txt"), "new\n");
              yield* git(cwd, ["add", "new.txt"]);
              yield* fileSystem.remove(NodePath.join(cwd, "new.txt"));
            } else if (scenario === "intent to add") {
              yield* writeTextFile(NodePath.join(cwd, "new.txt"), "new\n");
              yield* git(cwd, ["add", "-N", "new.txt"]);
            } else if (scenario === "subdirectory") {
              yield* writeTextFile(NodePath.join(cwd, "outside.txt"), "staged outside\n");
              yield* git(cwd, ["add", "outside.txt"]);
              cwd = NodePath.join(cwd, "inside");
            } else if (scenario === "assume unchanged" || scenario === "skip worktree") {
              yield* git(cwd, ["reset", "HEAD", "inside/file.txt"]);
              yield* git(cwd, [
                "update-index",
                scenario === "assume unchanged" ? "--assume-unchanged" : "--skip-worktree",
                "inside/file.txt",
              ]);
            } else if (scenario === "split index") {
              yield* git(cwd, ["update-index", "--split-index"]);
            } else if (scenario === "sparse checkout") {
              yield* git(cwd, ["sparse-checkout", "set", "--cone", "inside"]);
            } else if (scenario === "unmerged index") {
              const blob = yield* git(cwd, ["rev-parse", "HEAD:inside/file.txt"]);
              yield* git(cwd, ["update-index", "--force-remove", "inside/file.txt"]);
              yield* vcsProcess.run({
                operation: "CheckpointStore.test.conflict",
                command: "git",
                cwd,
                args: ["update-index", "--index-info"],
                stdin: `100644 ${blob} 1\tinside/file.txt\n100644 ${blob} 2\tinside/file.txt\n100644 ${blob} 3\tinside/file.txt\n`,
              });
            }
          }
          const indexPath = yield* git(cwd, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "index",
          ]);
          if (scenario === "missing index") yield* fileSystem.remove(indexPath);
          const indexExists = yield* fileSystem.exists(indexPath);
          const userIndex = indexExists ? yield* fileSystem.readFile(indexPath) : undefined;
          const referenceIndex = NodePath.join(yield* makeTmpDir(), "index");
          const referenceEnv = { ...process.env, GIT_INDEX_FILE: referenceIndex };
          if (hasHead) {
            yield* vcsProcess.run({
              operation: "CheckpointStore.test.baseline",
              command: "git",
              cwd,
              args: ["read-tree", "HEAD"],
              env: referenceEnv,
            });
          }
          yield* vcsProcess.run({
            operation: "CheckpointStore.test.baseline",
            command: "git",
            cwd,
            args: ["add", "-A", "--", "."],
            env: referenceEnv,
          });
          const expected = yield* vcsProcess.run({
            operation: "CheckpointStore.test.baseline",
            command: "git",
            cwd,
            args: ["write-tree"],
            env: referenceEnv,
          });
          const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("semantics"), 1);
          yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
          expect(yield* git(cwd, ["rev-parse", `${checkpointRef}^{tree}`])).toBe(
            expected.stdout.trim(),
          );
          expect(yield* fileSystem.exists(indexPath)).toBe(indexExists);
          if (userIndex) expect(yield* fileSystem.readFile(indexPath)).toEqual(userIndex);
          // Restore only this disposable fixture; capture must include actual on-disk content.
          if (scenario === "partial staging" || scenario === "linked worktree") {
            yield* writeTextFile(NodePath.join(cwd, "inside", "file.txt"), "after capture\n");
            expect(yield* checkpointStore.restoreCheckpoint({ cwd, checkpointRef })).toBe(true);
            expect(yield* fileSystem.readFileString(NodePath.join(cwd, "inside", "file.txt"))).toBe(
              "working tree content\n",
            );
          }
        }),
      );
    }

    it.effect("rehashes racy-clean files after copying the index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "core.trustctime", "false"]);
        const file = NodePath.join(tmp, "racy.txt");
        yield* writeTextFile(file, "before\n");
        yield* fileSystem.utimes(file, 1000, 1000);
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "racy file"]);
        const index = NodePath.join(tmp, ".git", "index");
        yield* fileSystem.utimes(index, 1000, 1000);
        yield* writeTextFile(file, "after!\n");
        yield* fileSystem.utimes(file, 1000, 1000);
        const userIndex = yield* fileSystem.readFile(index);
        const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("racy"), 1);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        expect(yield* git(tmp, ["show", `${checkpointRef}:racy.txt`])).toBe("after!");
        expect(yield* fileSystem.readFile(index)).toEqual(userIndex);
      }),
    );

    it.effect("reuses cached file metadata without changing the user index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        yield* initRepoWithCommit(tmp);
        const filter = NodePath.join(tmp, ".git", "count-clean.cjs");
        const calls = NodePath.join(tmp, ".git", "clean-calls");
        yield* writeTextFile(
          filter,
          `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(calls)}, "clean\\n"); process.stdin.pipe(process.stdout);`,
        );
        yield* git(tmp, ["config", "filter.count.clean", `node "${filter}"`]);
        yield* writeTextFile(NodePath.join(tmp, ".gitattributes"), "*.count filter=count\n");
        yield* writeTextFile(NodePath.join(tmp, "unchanged.count"), "unchanged\n");
        // Keep the fixture out of Git's racy-clean timestamp window without sleeping.
        yield* fileSystem.utimes(NodePath.join(tmp, "unchanged.count"), 1, 1);
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add filtered file"]);
        yield* writeTextFile(calls, "");
        const indexPath = NodePath.join(tmp, ".git", "index");
        const userIndex = yield* fileSystem.readFile(indexPath);
        const checkpointRef = checkpointRefForThreadTurn(ThreadId.make("cache-test"), 1);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* fileSystem.readFileString(calls)).toBe("");
        expect(yield* fileSystem.readFile(indexPath)).toEqual(userIndex);
        expect(yield* git(tmp, ["rev-parse", `${checkpointRef}^{tree}`])).toBe(
          yield* git(tmp, ["rev-parse", "HEAD^{tree}"]),
        );

        yield* writeTextFile(NodePath.join(tmp, "unchanged.count"), "changed content\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        expect(yield* git(tmp, ["show", `${checkpointRef}:unchanged.count`])).toBe(
          "changed content",
        );
        expect(yield* fileSystem.readFileString(calls)).not.toBe("");
        expect(yield* fileSystem.readFile(indexPath)).toEqual(userIndex);
      }),
    );
  });

  describe("diffCheckpoints", () => {
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

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-noprefix");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# changed\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
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

        for (const ignoreWhitespace of [false, true]) {
          const numstat = yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
            ignoreWhitespace,
            format: "numstat",
          });
          expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
            {
              path: "Component.tsx",
              additions: ignoreWhitespace ? 4 : 6,
              deletions: ignoreWhitespace ? 0 : 2,
            },
          ]);
        }
      }),
    );
  });

  describe("checkpoint file summaries", () => {
    it.effect("counts changes whose full patch exceeds the output limit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("large-checkpoint-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const filePath = NodePath.join(tmp, "README.md");
        const lineCount = 20_000;
        yield* writeTextFile(filePath, `${"before".repeat(50)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(filePath, `${"after".repeat(60)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: lineCount, deletions: lineCount },
        ]);
        expect(numstat.length).toBeLessThan(100);
      }),
    );

    it.effect("preserves file paths and turn ranges without changing the user index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.renames", "copies"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-paths");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const firstTurn = checkpointRefForThreadTurn(threadId, 1);
        const secondTurn = checkpointRefForThreadTurn(threadId, 2);
        const copiedText = Array.from({ length: 20 }, (_, index) => `copy line ${index}\n`).join(
          "",
        );
        const platform = yield* HostProcessPlatform;
        const renamedPath = platform === "win32" ? "renamed café.txt" : "renamed\tcafé\nname.txt";
        const addedPath = platform === "win32" ? "new café.txt" : "new\tfile\n名.txt";
        for (const [path, contents] of Object.entries({
          "copy-source.txt": copiedText,
          "deleted.txt": "delete me\n",
          "rename-old.txt": "before\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0before",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        yield* fileSystem.rename(
          NodePath.join(tmp, "rename-old.txt"),
          NodePath.join(tmp, renamedPath),
        );
        yield* fileSystem.remove(NodePath.join(tmp, "deleted.txt"));
        for (const [path, contents] of Object.entries({
          "copy-source.txt": `${copiedText}one more\n`,
          "copied.txt": copiedText,
          [renamedPath]: "after\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0after",
          "empty.txt": "",
          [addedPath]: "first\nsecond\n",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: firstTurn });
        const userIndex = yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"));
        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: firstTurn,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };
        const firstSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints(input),
        );
        const expectedFiles = [
          { path: "binary.bin", additions: 0, deletions: 0 },
          { path: "copied.txt", additions: 0, deletions: 0 },
          { path: "copy-source.txt", additions: 1, deletions: 0 },
          { path: "deleted.txt", additions: 0, deletions: 1 },
          { path: "empty.txt", additions: 0, deletions: 0 },
          { path: addedPath, additions: 2, deletions: 0 },
          { path: renamedPath, additions: 1, deletions: 1 },
        ].toSorted((left, right) => left.path.localeCompare(right.path));
        expect(firstSummary).toEqual(expectedFiles);

        yield* fileSystem.remove(NodePath.join(tmp, "empty.txt"));
        yield* writeTextFile(NodePath.join(tmp, "copy-source.txt"), "replacement\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: secondTurn });
        const secondSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: firstTurn,
            toCheckpointRef: secondTurn,
          }),
        );
        expect(secondSummary).toEqual([
          { path: "copy-source.txt", additions: 1, deletions: 21 },
          { path: "empty.txt", additions: 0, deletions: 0 },
        ]);

        const inclusiveSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: secondTurn }),
        );
        expect(inclusiveSummary).toEqual(
          expectedFiles
            .filter((file) => file.path !== "empty.txt")
            .map((file) =>
              file.path === "copy-source.txt" ? { ...file, additions: 1, deletions: 20 } : file,
            ),
        );
        expect(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: baseline }),
        ).toBe("");
        expect(yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"))).toEqual(userIndex);
      }),
    );

    it.effect("uses HEAD for a missing baseline only when requested", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-fallback");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "changed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        const input = {
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };

        const error = yield* Effect.flip(checkpointStore.diffCheckpoints(input));
        expect(error._tag).toBe("VcsProcessExitError");
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...input,
          fallbackFromToHead: true,
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: 1, deletions: 1 },
        ]);
      }),
    );
  });
});
