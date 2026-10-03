// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CheckpointScopeId, RunId, ThreadId, type VcsError } from "@t3tools/contracts";
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
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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
  for (const history of ["legacy metadata", "HEAD-only metadata", "amended HEAD"] as const) {
    it.effect(`keeps the full workspace delta with ${history}`, () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "upstream"]);
        yield* writeTextFile(NodePath.join(cwd, "imported.txt"), "upstream\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "upstream"]);
        yield* git(cwd, ["checkout", "-"]);
        yield* writeTextFile(NodePath.join(cwd, "own.txt"), "workspace\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "workspace commit"]);
        const store = yield* CheckpointStore.CheckpointStore;
        const fromCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("fallback"), 0);
        const toCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("fallback"), 1);
        yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        if (history === "amended HEAD") {
          yield* git(cwd, ["commit", "--amend", "-m", "rewritten workspace commit"]);
        } else {
          const tree = yield* git(cwd, ["rev-parse", `${fromCheckpointRef}^{tree}`]);
          const head = yield* git(cwd, ["rev-parse", "HEAD"]);
          const message = `t3 checkpoint ref=${fromCheckpointRef}${history === "HEAD-only metadata" ? `\nhead=${head}` : ""}`;
          const legacyCommit = yield* git(cwd, ["commit-tree", tree, "-m", message]);
          yield* git(cwd, ["update-ref", fromCheckpointRef, legacyCommit]);
        }
        yield* git(cwd, ["merge", "--no-ff", "upstream", "-m", "merge upstream"]);
        yield* writeTextFile(NodePath.join(cwd, "own.txt"), "workspace fix\n");
        yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const comparison = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* store.getGitChangedPaths(comparison)).toEqual([]);
        const patch = yield* store.diffCheckpoints(comparison);
        expect(patch).toContain("+upstream");
        expect(patch).toContain("+workspace fix");
      }),
    );
  }

  it.effect(
    "returns complete retained renames before an imported patch exceeds the output cap",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(NodePath.join(cwd, "old name.txt"), "same content\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "old file"]);
        yield* git(cwd, ["checkout", "-b", "upstream"]);
        yield* writeTextFile(NodePath.join(cwd, "new name.txt"), "same content\n");
        yield* writeTextFile(NodePath.join(cwd, "bulk.txt"), "upstream".repeat(1_300_000) + "\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "upstream additions"]);
        yield* git(cwd, ["checkout", "-"]);
        const store = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("filtered-rename");
        const scopeId = CheckpointScopeId.make("filtered-rename");
        const runId = RunId.make("filtered-rename");
        const fromCheckpointRef = checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 });
        const toCheckpointRef = checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 1 });
        yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        yield* git(cwd, ["rm", "old name.txt"]);
        yield* git(cwd, ["commit", "-m", "workspace deletion"]);
        yield* git(cwd, ["merge", "--no-ff", "upstream", "-m", "merge upstream"]);
        yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const comparison = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* store.getGitChangedPaths(comparison)).toEqual(["bulk.txt"]);
        const queryLayer = CheckpointDiffQuery.layer.pipe(
          Layer.provide(Layer.succeed(CheckpointStore.CheckpointStore, store)),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: () => Effect.fail(new OrchestratorProjectionError({ threadId })),
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [{ id: runId, ordinal: 1, status: "completed" }],
                  checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
                  checkpoints: [
                    { scopeId, runId, appRunOrdinal: 1, status: "ready", ref: toCheckpointRef },
                  ],
                }),
            }),
          ),
        );
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery.pipe(
          Effect.provide(queryLayer),
        );
        const input = { threadId, fromTurnCount: 0, toTurnCount: 1, ignoreWhitespace: false };
        const filtered = yield* query.getTurnDiff({ ...input, includeGitChanges: false });
        expect(filtered.diff).toContain("rename from old name.txt\nrename to new name.txt");
        expect(filtered.diff).not.toContain("bulk.txt");
        expect(filtered.gitFileCount).toBe(1);
        const full = yield* query.getTurnDiff({ ...input, includeGitChanges: true });
        expect(full.diff).toContain("bulk.txt");
        expect(full.diff.length).toBeGreaterThanOrEqual(10_000_000);
        expect(full.gitFileCount).toBe(1);
        expect((yield* query.getTurnDiff(input)).diff).toBe(full.diff);
        // Restoring still uses the complete checkpoint, including the hidden import.
        yield* store.restoreCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        yield* store.restoreCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.exists(NodePath.join(cwd, "old name.txt"))).toBe(false);
        expect(yield* fileSystem.readFileString(NodePath.join(cwd, "new name.txt"))).toBe(
          "same content\n",
        );
        expect((yield* fileSystem.stat(NodePath.join(cwd, "bulk.txt"))).size).toBe(10_400_001n);
      }),
  );

  it.effect(
    "keeps the full delta when switching to a descendant branch with an earlier merge",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "before"]);
        yield* git(cwd, ["checkout", "-b", "upstream"]);
        yield* writeTextFile(NodePath.join(cwd, "imported.txt"), "upstream\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "upstream"]);
        yield* git(cwd, ["checkout", "-b", "already-merged", "before"]);
        yield* git(cwd, ["merge", "--no-ff", "upstream", "-m", "earlier merge"]);
        yield* git(cwd, ["checkout", "before"]);
        const store = yield* CheckpointStore.CheckpointStore;
        const fromCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("branch-switch"), 0);
        const toCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("branch-switch"), 1);
        yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        yield* git(cwd, ["checkout", "already-merged"]);
        yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const comparison = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* store.getGitChangedPaths(comparison)).toEqual([]);
        expect(yield* store.diffCheckpoints(comparison)).toContain("+upstream");
      }),
  );

  it.effect(
    "keeps own commits visible when a fast-forward reaches them through a merge parent",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const mergeWorkspace = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const initialHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(NodePath.join(cwd, "before.txt"), "before turn\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "before turn"]);
        const store = yield* CheckpointStore.CheckpointStore;
        const fromCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-parent"), 0);
        const toCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-parent"), 1);
        yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(NodePath.join(cwd, "own-turn.txt"), "own turn edit\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "own turn edit"]);
        yield* git(cwd, ["worktree", "add", "-b", "remote-main", mergeWorkspace, initialHead]);
        yield* git(mergeWorkspace, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
        yield* git(cwd, ["merge", "--ff-only", "remote-main"]);
        yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const comparison = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* store.getGitChangedPaths(comparison)).toEqual([]);
        expect(yield* store.diffCheckpoints(comparison)).toContain("+own turn edit");
      }),
  );

  it.effect(
    "groups merged upstream files while retaining committed and uncommitted workspace edits",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "upstream"]);
        yield* git(cwd, ["checkout", "upstream"]);
        yield* writeTextFile(NodePath.join(cwd, "imported.txt"), "upstream\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "upstream work"]);
        yield* git(cwd, ["checkout", "-"]);
        yield* writeTextFile(NodePath.join(cwd, "own.txt"), "before\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "feature work"]);
        const store = yield* CheckpointStore.CheckpointStore;
        const fromCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-attribution"), 0);
        const toCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-attribution"), 1);
        yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
        yield* git(cwd, ["merge", "--no-ff", "upstream", "-m", "merge upstream"]);
        yield* writeTextFile(NodePath.join(cwd, "own.txt"), "after\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "fix"]);
        yield* writeTextFile(NodePath.join(cwd, "uncommitted.txt"), "local\n");
        yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
        const input = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
        expect(yield* store.getGitChangedPaths(input)).toEqual(["imported.txt"]);
        const patch = yield* store.diffCheckpoints(input);
        expect(patch).toContain("+upstream");
        expect(patch).toContain("+after");
        expect(patch).toContain("+local");
        const retainedPatch = yield* store.diffCheckpoints({
          ...input,
          filePaths: ["own.txt", "uncommitted.txt"],
        });
        expect(retainedPatch).not.toContain("imported.txt");
        expect(retainedPatch).toContain("+after");
        expect(retainedPatch).toContain("+local");
        expect(yield* store.diffCheckpoints({ ...input, filePaths: [] })).toBe("");
      }),
  );
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
  it.effect("keeps an upstream path visible when the workspace edits it after a merge", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "upstream"]);
      yield* git(cwd, ["checkout", "upstream"]);
      yield* writeTextFile(NodePath.join(cwd, "imported.txt"), "upstream\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "upstream"]);
      yield* git(cwd, ["checkout", "-"]);
      const store = yield* CheckpointStore.CheckpointStore;
      const fromCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-edits"), 0);
      const toCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-edits"), 1);
      yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
      yield* git(cwd, ["merge", "--no-ff", "upstream", "-m", "merge"]);
      yield* writeTextFile(NodePath.join(cwd, "imported.txt"), "upstream\nworkspace fix\n");
      yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
      expect(
        yield* store.getGitChangedPaths({
          cwd,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        }),
      ).toEqual([]);
    }),
  );

  it.effect("keeps overlapping merge paths visible even when the resolution chooses upstream", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "upstream"]);
      yield* git(cwd, ["checkout", "upstream"]);
      yield* writeTextFile(NodePath.join(cwd, "README.md"), "upstream\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "upstream"]);
      yield* git(cwd, ["checkout", "-"]);
      yield* writeTextFile(NodePath.join(cwd, "README.md"), "feature\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "feature"]);
      const store = yield* CheckpointStore.CheckpointStore;
      const fromCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-conflict"), 0);
      const toCheckpointRef = checkpointRefForThreadTurn(ThreadId.make("merge-conflict"), 1);
      yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
      yield* git(cwd, ["merge", "upstream"]).pipe(Effect.flip);
      yield* writeTextFile(NodePath.join(cwd, "README.md"), "upstream\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "resolve conflict"]);
      yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
      const input = { cwd, fromCheckpointRef, toCheckpointRef, ignoreWhitespace: false };
      expect(yield* store.getGitChangedPaths(input)).toEqual([]);
      expect(yield* store.diffCheckpoints(input)).toContain("+upstream");
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
  });
});
