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
import { JjCoreLive } from "../../jj/Layers/JjCore.ts";
import { initJjRepo } from "../../jj/Layers/JjTestUtils.ts";
import { VcsCoreLive } from "../../vcs/Layers/VcsCore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const JjCoreTestLayer = JjCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(GitCoreTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const VcsCoreTestLayer = VcsCoreLive.pipe(
  Layer.provideMerge(GitCoreTestLayer),
  Layer.provideMerge(JjCoreTestLayer),
);
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provideMerge(VcsCoreTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  GitCoreTestLayer,
  JjCoreTestLayer,
  VcsCoreTestLayer,
  CheckpointStoreTestLayer,
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

function fsReadText(
  filePath: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath);
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

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("diffCheckpoints", () => {
    it.effect(
      "returns full oversized checkpoint diffs without truncation for git repositories",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.makeUnsafe("thread-checkpoint-store");
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

    it.effect("captures JJ checkpoints as native revisions instead of hidden git refs", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-store-jj-test-");
        yield* initJjRepo(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-store-jj");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const fileSystem = yield* FileSystem.FileSystem;

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "notes.txt"), "native jj checkpoint\n");
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
        expect(diff).toContain("+++ b/notes.txt");

        const gitCore = yield* GitCore;
        const gitRefResult = yield* gitCore.execute({
          operation: "CheckpointStore.test.git.verifyMissingRef",
          cwd: tmp,
          args: ["rev-parse", "--verify", "--quiet", `${toCheckpointRef}^{commit}`],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        expect(gitRefResult.code).not.toBe(0);

        yield* fileSystem.remove(path.join(tmp, "notes.txt"));
        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });
        expect(restored).toBe(true);
        expect(yield* fsReadText(path.join(tmp, "notes.txt"))).toBe("native jj checkpoint\n");

        const restoredToInitial = yield* checkpointStore.restoreCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        expect(restoredToInitial).toBe(true);
        const notesExists = yield* fileSystem.stat(path.join(tmp, "notes.txt")).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
        expect(notesExists).toBe(false);
      }),
    );
  });
});
