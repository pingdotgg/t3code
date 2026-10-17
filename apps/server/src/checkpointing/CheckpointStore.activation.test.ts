// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { createJjRepo, describeJj, runGit, runJj } from "../vcs/testing/JjTestSupport.ts";
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

it.layer(layerTest)("CheckpointStore activation", (it) => {
  describeJj("with Jujutsu installed", () => {
    it.effect(
      "restores a Git-captured checkpoint after activation without a visible checkpoint commit",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const fs = yield* FileSystem.FileSystem;
          yield* runGit(cwd, ["init", "--initial-branch=main"]);
          yield* runGit(cwd, ["config", "user.name", "Test"]);
          yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
          const file = NodePath.join(cwd, "tracked.txt");
          yield* fs.writeFileString(file, "initial\n");
          yield* runGit(cwd, ["add", "."]);
          yield* runGit(cwd, ["commit", "-m", "initial"]);
          const head = (yield* runGit(cwd, ["rev-parse", "HEAD"])).trim();
          yield* fs.writeFileString(file, "captured\n");
          const store = yield* CheckpointStore.CheckpointStore;
          const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/activation/0");
          yield* store.captureCheckpoint({ cwd, checkpointRef });
          const captured = (yield* runGit(cwd, ["rev-parse", checkpointRef])).trim();
          yield* createJjRepo(cwd);
          yield* fs.writeFileString(file, "later\n");
          yield* store.restoreCheckpoint({ cwd, checkpointRef });
          expect(yield* fs.readFileString(file)).toBe("captured\n");
          expect((yield* runGit(cwd, ["rev-parse", "refs/heads/main"])).trim()).toBe(head);
          const visible = yield* runJj(cwd, [
            "log",
            "--no-graph",
            "-r",
            "all()",
            "-T",
            'commit_id ++ "\\n"',
          ]);
          expect(visible).not.toContain(captured);
        }),
    );
    it.effect("returns true for a colocated Jujutsu repository", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* createJjRepo(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        expect(yield* checkpointStore.supportsCheckpoints(tmp)).toBe(true);
      }),
    );
    it.effect("returns false for a Jujutsu repository with no colocated Git store", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const base = yield* makeTmpDir();
        const store = NodePath.join(base, "store.git");
        const root = NodePath.join(base, "project");
        yield* fileSystem.makeDirectory(store, { recursive: true });
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* runGit(store, ["init", "--bare", "--initial-branch=main", store]);
        yield* runJj(root, ["git", "init", "--git-repo", store]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        expect(yield* checkpointStore.supportsCheckpoints(root)).toBe(false);
      }),
    );
  });
});
