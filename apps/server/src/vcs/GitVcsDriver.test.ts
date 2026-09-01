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

it.effect("GitVcsDriver stages only changed paths when capturing a checkpoint", () => {
  const commands: Array<VcsProcess.VcsProcessInput> = [];
  const changedPaths = ["changed.ts", "deleted.ts", "dir/new\nfile.ts", ":literal.ts"];
  const invalidUtf8Path = new Uint8Array([0xff, ...new TextEncoder().encode(".txt")]);
  const statusBytes = Buffer.concat([
    Buffer.from(
      ` M ${changedPaths[0]}\0 D ${changedPaths[1]}\0?? ${changedPaths[2]}\0?? ${changedPaths[3]}\0?? `,
    ),
    invalidUtf8Path,
    Buffer.from([0]),
  ]);
  const expectedPathspec = Buffer.concat([
    Buffer.from(`${changedPaths.join("\0")}\0`),
    invalidUtf8Path,
    Buffer.from([0]),
  ]);

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    assert.isDefined(driver.checkpoints);

    yield* driver.checkpoints.captureCheckpoint({
      cwd: process.cwd(),
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/test/turn/1"),
    });

    const statusCommand = commands.find((command) => command.args[2] === "status");
    assert.isDefined(statusCommand);
    assert.deepStrictEqual(statusCommand.args.slice(2), [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--",
      ".",
    ]);
    assert.strictEqual(statusCommand.env?.GIT_OPTIONAL_LOCKS, "0");
    assert.strictEqual(statusCommand.captureStdoutBytes, true);

    const addCommand = commands.find((command) => command.args[3] === "add");
    assert.isDefined(addCommand);
    assert.deepStrictEqual(addCommand.args.slice(2), [
      "--literal-pathspecs",
      "add",
      "-A",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ]);
    assert.instanceOf(addCommand.stdin, Uint8Array);
    assert.deepStrictEqual(addCommand.stdin, expectedPathspec);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              commands.push(input);
              const args = input.args.slice(2);
              const stdout =
                args[0] === "status"
                  ? new TextDecoder().decode(statusBytes)
                  : args[0] === "rev-parse" && args[1] === "--git-common-dir"
                    ? ".git\n"
                    : args[0] === "rev-parse" && args[1] === "--show-toplevel"
                      ? `${process.cwd()}\n`
                      : args[0] === "write-tree"
                        ? "tree-oid\n"
                        : args[0] === "commit-tree"
                          ? "commit-oid\n"
                          : "";
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
                ...(args[0] === "status" ? { stdoutBytes: statusBytes } : {}),
              };
            }),
        }),
      ),
    ),
  );
});

it.effect("GitVcsDriver captures scoped working tree changes without changing the real index", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-git-checkpoint-paths-",
      });
      const scopeCwd = path.join(cwd, "scope");
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test/turn/1");
      assert.isDefined(driver.checkpoints);

      const git = (gitCwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
        driver.execute({
          operation: "GitVcsDriver.test.checkpointPaths",
          cwd: gitCwd,
          args,
          allowNonZeroExit,
          timeoutMs: 10_000,
        });
      const write = (relativePath: string, contents: string) =>
        fileSystem.writeFileString(path.join(cwd, relativePath), contents);

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* fileSystem.makeDirectory(scopeCwd);
      yield* write("scope/changed.txt", "original changed\n");
      yield* write("scope/deleted.txt", "original deleted\n");
      yield* write("scope/staged.txt", "original staged\n");
      yield* write("outside.txt", "original outside\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "initial"]);

      yield* write("scope/staged.txt", "staged version\n");
      yield* git(cwd, ["add", "scope/staged.txt"]);
      const indexTreeBefore = (yield* git(cwd, ["write-tree"])).stdout.trim();

      yield* write("scope/changed.txt", "working changed\n");
      yield* write("scope/staged.txt", "working version\n");
      yield* write("scope/new file [1].txt", "new file\n");
      yield* write("outside.txt", "working outside\n");
      yield* fileSystem.remove(path.join(scopeCwd, "deleted.txt"));

      yield* driver.checkpoints.captureCheckpoint({ cwd: scopeCwd, checkpointRef });

      const indexTreeAfter = (yield* git(cwd, ["write-tree"])).stdout.trim();
      assert.strictEqual(indexTreeAfter, indexTreeBefore);
      assert.strictEqual(
        (yield* git(cwd, ["show", `${checkpointRef}:scope/changed.txt`])).stdout,
        "working changed\n",
      );
      assert.strictEqual(
        (yield* git(cwd, ["show", `${checkpointRef}:scope/staged.txt`])).stdout,
        "working version\n",
      );
      assert.strictEqual(
        (yield* git(cwd, ["show", `${checkpointRef}:scope/new file [1].txt`])).stdout,
        "new file\n",
      );
      assert.strictEqual(
        (yield* git(cwd, ["show", `${checkpointRef}:outside.txt`])).stdout,
        "original outside\n",
      );
      assert.notStrictEqual(
        (yield* git(cwd, ["cat-file", "-e", `${checkpointRef}:scope/deleted.txt`], true)).exitCode,
        0,
      );
    }).pipe(Effect.provide(GitContractLayer)),
  ),
);
