// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver normalizes checkpoint temp indexes and removes lock files", () => {
  let gitDir = "";
  let currentIndexPath = "";
  let tempIndexPath = "";
  let readTreeArgs: ReadonlyArray<string> | undefined;
  let updateIndexArgs: ReadonlyArray<string> | undefined;
  let copiedIndexContents = "";

  const processLayer = Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.sync(() => {
        const args = input.args.slice(2);
        let stdout = "";

        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          stdout = gitDir;
        } else if (args[0] === "rev-parse" && args[1] === "--git-path") {
          stdout = currentIndexPath;
        } else if (args[0] === "read-tree") {
          readTreeArgs = args;
        } else if (args[0] === "ls-files") {
          stdout = "H tracked.txt\0";
        } else if (args[0] === "update-index") {
          updateIndexArgs = args;
        } else if (args[0] === "add") {
          tempIndexPath = input.env?.GIT_INDEX_FILE ?? "";
          copiedIndexContents = NodeFS.readFileSync(tempIndexPath, "utf8");
          NodeFS.writeFileSync(`${tempIndexPath}.lock`, "locked");
        } else if (args[0] === "write-tree") {
          stdout = "tree-oid\n";
        } else if (args[0] === "commit-tree") {
          stdout = "commit-oid\n";
        }

        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-index-" });
    gitDir = path.join(cwd, ".git");
    currentIndexPath = path.join(gitDir, "index");
    yield* fileSystem.makeDirectory(gitDir, { recursive: true });
    yield* fileSystem.writeFileString(currentIndexPath, "current-index");

    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    yield* driver.checkpoints.captureCheckpoint({
      cwd,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/test"),
    });

    assert.deepStrictEqual(readTreeArgs, ["read-tree", "--reset", "HEAD"]);
    assert.deepStrictEqual(updateIndexArgs, [
      "update-index",
      "--no-split-index",
      "--no-untracked-cache",
      "--no-fsmonitor",
    ]);
    assert.strictEqual(copiedIndexContents, "current-index");
    assert.strictEqual(NodeFS.existsSync(tempIndexPath), false);
    assert.strictEqual(NodeFS.existsSync(`${tempIndexPath}.lock`), false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, processLayer)));
});

it.effect("GitVcsDriver checkpoints files hidden by worktree index flags", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-flags-" });
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/index-flags");

    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(cwd, "assumed.txt"), "committed\n");
    yield* fileSystem.writeFileString(path.join(cwd, "skipped.txt"), "committed\n");
    yield* runGit(cwd, ["add", "assumed.txt", "skipped.txt"]);
    yield* runGit(cwd, ["commit", "-m", "initial"]);
    yield* runGit(cwd, ["update-index", "--assume-unchanged", "assumed.txt"]);
    yield* runGit(cwd, ["update-index", "--skip-worktree", "skipped.txt"]);
    yield* fileSystem.writeFileString(path.join(cwd, "assumed.txt"), "checkpointed\n");
    yield* fileSystem.writeFileString(path.join(cwd, "skipped.txt"), "checkpointed\n");

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    const assumed = yield* driver.execute({
      operation: "GitVcsDriver.test.readAssumedCheckpointFile",
      cwd,
      args: ["show", `${checkpointRef}:assumed.txt`],
    });
    const skipped = yield* driver.execute({
      operation: "GitVcsDriver.test.readSkippedCheckpointFile",
      cwd,
      args: ["show", `${checkpointRef}:skipped.txt`],
    });

    assert.strictEqual(assumed.stdout, "checkpointed\n");
    assert.strictEqual(skipped.stdout, "checkpointed\n");
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);
