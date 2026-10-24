// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerVcsDriverTest = VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest));
const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provideMerge(layerVcsDriverTest),
  Layer.provideMerge(NodeServices.layer),
);
// A read may return fewer bytes than asked for. "short" returns at most 160 bytes per read, and
// "stop" also ends the file after its first read, as a truncation racing the read would.
let reflogReadFault: "short" | "stop" | "none" = "none";
const layerShortReadFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fileSystem) =>
    FileSystem.FileSystem.of({
      ...fileSystem,
      open: (path, options) =>
        Effect.map(fileSystem.open(path, options), (file) => {
          let reads = 0;
          return new Proxy(file, {
            get: (target, key) => {
              if (key === "readAlloc") {
                return (size: number) =>
                  reflogReadFault === "stop" && reads++ > 0
                    ? Effect.succeedNone
                    : target.readAlloc(reflogReadFault === "none" ? size : Math.min(size, 160));
              }
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }),
    }),
  ),
).pipe(Layer.provide(NodeServices.layer));
const layerShortReadCheckpointStore = Layer.fresh(CheckpointStore.layer).pipe(
  Layer.provide(
    Layer.fresh(VcsDriverRegistry.layer).pipe(
      Layer.provide(layerVcsProcessTest),
      Layer.provide(layerShortReadFileSystem),
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);
const layerTest = layerCheckpointStoreTest.pipe(
  Layer.provideMerge(layerVcsProcessTest),
  Layer.provideMerge(layerVcsDriverTest),
  Layer.provideMerge(layerServerConfig),
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
  options: { readonly committedAt?: string; readonly allowNonZeroExit?: boolean } = {},
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
      ...(options.committedAt === undefined
        ? {}
        : { env: { ...process.env, GIT_COMMITTER_DATE: options.committedAt } }),
      ...(options.allowNonZeroExit === undefined
        ? {}
        : { allowNonZeroExit: options.allowNonZeroExit }),
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

it.layer(layerTest)("CheckpointStore.layer", (it) => {
  it.effect("detects a nested workspace without its own .git entry", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(tmp, "packages", "nested");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      expect(yield* checkpointStore.isGitRepository(nested)).toBe(true);
    }),
  );
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
        const platform = yield* HostProcess.Platform;
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
          { path: "copied.txt", previousPath: "copy-source.txt", additions: 0, deletions: 0 },
          { path: "copy-source.txt", additions: 1, deletions: 0 },
          { path: "deleted.txt", additions: 0, deletions: 1 },
          { path: "empty.txt", additions: 0, deletions: 0 },
          { path: addedPath, additions: 2, deletions: 0 },
          { path: renamedPath, previousPath: "rename-old.txt", additions: 1, deletions: 1 },
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
    it.effect("limits a diff to repository paths from a subdirectory workspace", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = NodePath.join(tmp, "app");
        yield* fileSystem.makeDirectory(cwd);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-file-paths-subdirectory");
        const refs = {
          cwd,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.fromCheckpointRef });
        yield* writeTextFile(NodePath.join(cwd, "kept.txt"), "kept\n");
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# hidden\n");
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.toCheckpointRef });

        const patch = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          filePaths: ["app/kept.txt"],
        });
        expect(patch).toContain("+kept");
        expect(patch).not.toContain("hidden");
      }),
    );
  });

  describe("listAuthoredPaths", () => {
    it.effect("leaves out paths that only a merged upstream changed", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-authored-paths");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        const commitBeforeTurn = (file: string, contents: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(NodePath.join(tmp, file), contents);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", file], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* git(tmp, ["checkout", "-b", "upstream"]);
        yield* commitBeforeTurn("upstream.txt", "upstream\n");
        yield* commitBeforeTurn("shared.txt", "upstream\n");
        yield* git(tmp, ["checkout", "-"]);
        yield* commitBeforeTurn("shared.txt", "ours\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toBeNull();

        yield* git(tmp, ["merge", "upstream", "--no-edit"], { allowNonZeroExit: true });
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "upstream\n");
        yield* git(tmp, ["commit", "-am", "merge upstream"]);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# edited\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat).map((file) => file.path)).toEqual([
          "README.md",
          "shared.txt",
          "upstream.txt",
        ]);
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(
          new Set(["README.md", "shared.txt"]),
        );
      }),
    );

    // A turn that switches branches starts from the branch it switched to, while a reset or
    // rename keeps the branch it had.
    const captureTurnAcrossHeadMove = (
      threadId: string,
      moveHead: (
        cwd: string,
      ) => Effect.Effect<
        void,
        VcsError | PlatformError.PlatformError,
        VcsProcess.VcsProcess | FileSystem.FileSystem
      >,
    ) =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const id = ThreadId.make(threadId);
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(id, 1),
          toCheckpointRef: checkpointRefForThreadTurn(id, 2),
        };
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "base\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        yield* git(tmp, ["branch", "branch-b"]);
        yield* git(tmp, ["checkout", "-b", "branch-a"]);
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "A content\n");
        yield* writeTextFile(NodePath.join(tmp, "a.txt"), "A only\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "branch A change"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });

        yield* moveHead(tmp);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.toCheckpointRef,
          previousCheckpointRef: refs.fromCheckpointRef,
        });

        const patch = yield* checkpointStore.diffCheckpoints({ ...refs, ignoreWhitespace: false });
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          format: "numstat",
        });
        const authoredPaths = yield* checkpointStore.listAuthoredPaths(refs);
        return {
          authoredPaths,
          changedLines: patch
            .split("\n")
            .filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line)),
          files: parseTurnDiffFilesFromNumstat(numstat).filter(
            (file) => !isGitImport(file, authoredPaths),
          ),
        };
      });

    it.effect.each([
      ["switch", "branch-b"],
      ["switch", "--detach", "branch-b"],
    ])("diffs from the destination after git %s", (switchArgs) =>
      Effect.gen(function* () {
        const turn = yield* captureTurnAcrossHeadMove("checkpoint-switch", (cwd) =>
          Effect.gen(function* () {
            yield* git(cwd, switchArgs);
            yield* writeTextFile(NodePath.join(cwd, "shared.txt"), "B edit\n");
          }),
        );

        expect(turn.changedLines).toEqual(["-base", "+B edit"]);
        expect(turn.files).toEqual([{ path: "shared.txt", additions: 1, deletions: 1 }]);
        expect(turn.authoredPaths).toEqual(new Set(["a.txt", "shared.txt"]));
      }),
    );

    it.effect("keeps a reset's deletions when the turn then switches branches", () =>
      Effect.gen(function* () {
        const turn = yield* captureTurnAcrossHeadMove("checkpoint-reset-switch", (cwd) =>
          Effect.gen(function* () {
            yield* git(cwd, ["reset", "--hard", "HEAD~1"]);
            yield* git(cwd, ["switch", "branch-b"]);
            yield* writeTextFile(NodePath.join(cwd, "b.txt"), "B only\n");
          }),
        );

        expect(turn.changedLines).toEqual(["-A only", "+B only", "-A content", "+base"]);
        expect(turn.files).toEqual([
          { path: "a.txt", additions: 0, deletions: 1 },
          { path: "b.txt", additions: 1, deletions: 0 },
          { path: "shared.txt", additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("does not replay a switch that an earlier checkpoint already followed", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const id = ThreadId.make("checkpoint-switch-then-reset");
        const [first, second, third] = [1, 2, 3].map((turn) =>
          checkpointRefForThreadTurn(id, turn),
        );
        yield* git(tmp, ["branch", "branch-b"]);
        yield* git(tmp, ["checkout", "-b", "branch-a"]);
        yield* writeTextFile(NodePath.join(tmp, "a.txt"), "A only\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "branch A change"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: first! });
        yield* git(tmp, ["switch", "branch-b"]);
        yield* writeTextFile(NodePath.join(tmp, "b.txt"), "B only\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "branch B change"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: second!,
          previousCheckpointRef: first!,
        });

        yield* git(tmp, ["reset", "--hard", "HEAD~1"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: third!,
          previousCheckpointRef: second!,
        });

        const refs = { cwd: tmp, fromCheckpointRef: second!, toCheckpointRef: third! };
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          format: "numstat",
        });
        const authoredPaths = yield* checkpointStore.listAuthoredPaths(refs);
        expect(
          parseTurnDiffFilesFromNumstat(numstat).filter(
            (file) => !isGitImport(file, authoredPaths),
          ),
        ).toEqual([{ path: "b.txt", additions: 0, deletions: 1 }]);
      }),
    );

    it.effect("keeps a reset's deletions when the turn renames its branch", () =>
      Effect.gen(function* () {
        const turn = yield* captureTurnAcrossHeadMove("checkpoint-rename-reset", (cwd) =>
          Effect.gen(function* () {
            yield* git(cwd, ["branch", "-m", "renamed"]);
            yield* git(cwd, ["reset", "--hard", "HEAD~1"]);
          }),
        );

        expect(turn.changedLines).toEqual(["-A only", "-A content", "+base"]);
        expect(turn.files).toEqual([
          { path: "a.txt", additions: 0, deletions: 1 },
          { path: "shared.txt", additions: 1, deletions: 1 },
        ]);
      }),
    );

    it.effect("follows a switch read from the reflog in short reads", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore.pipe(
          Effect.provide(layerShortReadCheckpointStore),
        );
        reflogReadFault = "short";
        const id = ThreadId.make("checkpoint-switch-short-read");
        const [first, second, third] = [1, 2, 3].map((turn) =>
          checkpointRefForThreadTurn(id, turn),
        );
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "base\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        yield* git(tmp, ["branch", "branch-b"]);
        yield* git(tmp, ["checkout", "-b", "branch-a"]);
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "A content\n");
        yield* git(tmp, ["commit", "-am", "branch A change"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: first! });

        yield* git(tmp, ["switch", "branch-b"]);
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "B edit\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: second!,
          previousCheckpointRef: first!,
        });

        yield* git(tmp, ["reset", "--hard", "HEAD"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: third!,
          previousCheckpointRef: second!,
        });

        const patch = (fromCheckpointRef: typeof first, toCheckpointRef: typeof first) =>
          checkpointStore
            .diffCheckpoints({
              cwd: tmp,
              fromCheckpointRef: fromCheckpointRef!,
              toCheckpointRef: toCheckpointRef!,
              ignoreWhitespace: false,
            })
            .pipe(
              Effect.map((diff) =>
                diff
                  .split("\n")
                  .filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line)),
              ),
            );
        expect(yield* patch(first, second)).toEqual(["-base", "+B edit"]);
        expect(yield* patch(second, third)).toEqual(["-B edit", "+base"]);
      }),
    );

    it.effect("publishes no reflog cursor from a read that ends early", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore.pipe(
          Effect.provide(layerShortReadCheckpointStore),
        );
        reflogReadFault = "none";
        const id = ThreadId.make("checkpoint-switch-read-ends-early");
        const [first, second, third] = [1, 2, 3].map((turn) =>
          checkpointRefForThreadTurn(id, turn),
        );
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "base\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "base"]);
        yield* git(tmp, ["branch", "branch-b"]);
        yield* git(tmp, ["checkout", "-b", "branch-a"]);
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "A content\n");
        yield* git(tmp, ["commit", "-am", "branch A change"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: first! });

        yield* git(tmp, ["switch", "branch-b"]);
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "B edit\n");
        reflogReadFault = "stop";
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: second!,
          previousCheckpointRef: first!,
        });

        reflogReadFault = "none";
        yield* git(tmp, ["reset", "--hard", "HEAD"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: third!,
          previousCheckpointRef: second!,
        });

        const patch = (fromCheckpointRef: typeof first, toCheckpointRef: typeof first) =>
          checkpointStore
            .diffCheckpoints({
              cwd: tmp,
              fromCheckpointRef: fromCheckpointRef!,
              toCheckpointRef: toCheckpointRef!,
              ignoreWhitespace: false,
            })
            .pipe(
              Effect.map((diff) =>
                diff
                  .split("\n")
                  .filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line)),
              ),
            );
        expect(yield* patch(first, second)).toEqual(["-A content", "+B edit"]);
        expect(yield* patch(second, third)).toEqual(["-B edit", "+base"]);
      }),
    );

    // Linux stores any bytes as a file name, unlike macOS and Windows.
    it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
      "keeps non-UTF-8 file names that a branch switch removes or replaces",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const id = ThreadId.make("checkpoint-switch-non-utf8");
          const refs = {
            cwd: tmp,
            fromCheckpointRef: checkpointRefForThreadTurn(id, 1),
            toCheckpointRef: checkpointRefForThreadTurn(id, 2),
          };
          const rawPath = (name: string, byte: number) =>
            Buffer.concat([Buffer.from(NodePath.join(tmp, name)), Buffer.from([byte])]);
          yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "base\n");
          NodeFS.writeFileSync(rawPath("replaced-", 0xfe), "B bytes\n");
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "base"]);
          yield* git(tmp, ["branch", "branch-b"]);
          yield* git(tmp, ["checkout", "-b", "branch-a"]);
          NodeFS.writeFileSync(rawPath("replaced-", 0xfe), "A bytes\n");
          NodeFS.writeFileSync(rawPath("removed-", 0xff), "A only\n");
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "branch A non-UTF-8 names"]);
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: refs.fromCheckpointRef,
          });

          yield* git(tmp, ["switch", "branch-b"]);
          yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "B edit\n");
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: refs.toCheckpointRef,
            previousCheckpointRef: refs.fromCheckpointRef,
          });

          const numstat = yield* checkpointStore.diffCheckpoints({
            ...refs,
            ignoreWhitespace: false,
            format: "numstat",
          });
          const authoredPaths = yield* checkpointStore.listAuthoredPaths(refs);
          expect(
            parseTurnDiffFilesFromNumstat(numstat).filter(
              (file) => !isGitImport(file, authoredPaths),
            ),
          ).toEqual([{ path: "shared.txt", additions: 1, deletions: 1 }]);
        }),
    );
  });
});
