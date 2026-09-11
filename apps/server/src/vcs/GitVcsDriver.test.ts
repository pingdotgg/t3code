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

const makeCheckpointFixture = Effect.fn("makeCheckpointFixture")(function* (
  driver: Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "checkpoint-test", cwd, args });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect("checkpoint capture does not rerun clean filters for unchanged indexed files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-cache-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(
      path.join(cwd, ".gitattributes"),
      "stable.txt filter=probe\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "stable.txt"), "unchanged\n");
    yield* fileSystem.writeFileString(
      path.join(cwd, ".git", "filter.cjs"),
      'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
    );
    yield* git(["config", "filter.probe.clean", "node .git/filter.cjs"]);
    yield* fileSystem.utimes(path.join(cwd, "stable.txt"), 1_700_000_000, 1_700_000_000);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record stable file"]);
    yield* fileSystem.writeFileString(path.join(cwd, ".git", "filter-runs"), "");
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "changed\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, ".git", "filter-runs")), "");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "changed\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:stable.txt`])).stdout, "unchanged\n");
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

for (const timestamp of [1_700_000_000, 1_700_000_000.9999]) {
  it.effect(
    `checkpoint capture preserves same-size edits with racy index timestamps (${timestamp})`,
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-" });
        const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
        const filePath = path.join(cwd, "file.txt");
        const indexPath = path.join(cwd, ".git", "index");
        yield* git(["config", "core.trustctime", "false"]);
        yield* fileSystem.writeFileString(filePath, "before\n");
        yield* fileSystem.utimes(filePath, timestamp, timestamp);
        yield* git(["add", "file.txt"]);
        yield* git(["commit", "-m", "record racy file"]);
        yield* fileSystem.utimes(indexPath, timestamp, timestamp);
        const originalIndex = yield* fileSystem.readFile(indexPath);
        const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
        yield* fileSystem.writeFileString(filePath, "after!\n");
        yield* fileSystem.utimes(filePath, timestamp, timestamp);

        yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

        assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "after!\n");
        assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
        assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
      }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

it.effect("checkpoint capture preserves racy edits made after resetting the index", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-reset-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const racyPath = path.join(cwd, "racy.txt");
    const indexPath = path.join(cwd, ".git", "index");
    const timestamp = 1_700_000_000;
    yield* git(["config", "core.trustctime", "false"]);
    yield* fileSystem.writeFileString(racyPath, "before\n");
    yield* fileSystem.utimes(racyPath, timestamp, timestamp);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record racy file"]);
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
    yield* git(["add", "file.txt"]);
    yield* fileSystem.utimes(indexPath, timestamp, timestamp);
    const originalIndex = yield* fileSystem.readFile(indexPath);
    const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: Effect.fn(function* (input: VcsProcess.VcsProcessInput) {
          const result = yield* liveProcess.run(input);
          if (input.args.includes("read-tree") && input.args.includes("--reset")) {
            yield* fileSystem.writeFileString(racyPath, "after!\n").pipe(Effect.orDie);
            yield* fileSystem.utimes(racyPath, timestamp, timestamp).pipe(Effect.orDie);
          }
          return result;
        }),
      }),
    );

    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:racy.txt`])).stdout, "after!\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "staged\n");
    assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
    assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

for (const nested of [false, true]) {
  for (const indexMode of ["normal", "flags", "split"] as const) {
    it.effect(
      `checkpoint index reuse preserves two turns (nested=${nested}, index=${indexMode})`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.makeVcsDriverShape();
          const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-turns-" });
          const { git } = yield* makeCheckpointFixture(driver, cwd);
          const write = (name: string, contents: string) =>
            fileSystem.writeFileString(path.join(cwd, name), contents);
          yield* fileSystem.makeDirectory(path.join(cwd, "scope"));
          for (const name of [
            "scope/staged",
            "scope/deleted",
            "scope/assumed",
            "scope/skipped",
            "outside",
          ]) {
            yield* write(name, "original\n");
          }
          yield* git(["add", "."]);
          yield* git(["commit", "-m", "initial scoped files"]);
          yield* write("scope/staged", "staged\n");
          yield* write("scope/new-deleted", "staged then deleted\n");
          yield* write("outside", "staged outside\n");
          yield* git(["add", "."]);
          if (indexMode === "flags") {
            yield* git(["update-index", "--assume-unchanged", "scope/assumed"]);
            yield* git(["update-index", "--skip-worktree", "scope/skipped"]);
          }
          if (indexMode === "split") {
            yield* git(["update-index", "--split-index"]);
          }
          const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));
          for (const name of ["scope/staged", "scope/assumed", "scope/skipped", "outside"]) {
            yield* write(name, "working\n");
          }
          yield* write("scope/new", "first\n");
          yield* fileSystem.remove(path.join(cwd, "scope/deleted"));
          yield* fileSystem.remove(path.join(cwd, "scope/new-deleted"));
          const captureCwd = nested ? path.join(cwd, "scope") : cwd;
          const first = CheckpointRef.make("refs/t3/checkpoints/turns/1");
          const second = CheckpointRef.make("refs/t3/checkpoints/turns/2");
          yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: first });
          for (const name of ["scope/staged", "scope/assumed", "scope/skipped"]) {
            assert.strictEqual((yield* git(["show", `${first}:${name}`])).stdout, "working\n");
          }
          assert.strictEqual(
            (yield* git(["show", `${first}:outside`])).stdout,
            nested ? "original\n" : "working\n",
          );
          const files = (yield* git(["ls-tree", "-r", "--name-only", first])).stdout.split("\n");
          assert.notInclude(files, "scope/deleted");
          assert.notInclude(files, "scope/new-deleted");
          assert.include(files, "scope/new");

          yield* write("scope/staged", "second\n");
          yield* fileSystem.remove(path.join(cwd, "scope/new"));
          yield* write("scope/second", "added in second turn\n");
          yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: second });
          assert.strictEqual(
            (yield* git(["diff", "--name-only", first, second])).stdout,
            "scope/new\nscope/second\nscope/staged\n",
          );
          assert.strictEqual((yield* git(["show", `${second}:scope/staged`])).stdout, "second\n");
          assert.strictEqual(
            (yield* git(["show", `${second}:scope/second`])).stdout,
            "added in second turn\n",
          );
          assert.deepEqual(
            yield* fileSystem.readFile(path.join(cwd, ".git", "index")),
            originalIndex,
          );
        }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
    );
  }
}

for (const indexState of ["missing", "invalid"] as const) {
  it.effect(`checkpoint capture falls back when the user index is ${indexState}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-index-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const indexPath = path.join(cwd, ".git", "index");
      if (indexState === "missing") {
        yield* fileSystem.remove(indexPath);
      } else {
        yield* fileSystem.writeFileString(indexPath, "invalid index");
      }

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      if (indexState === "missing") {
        assert.isFalse(yield* fileSystem.exists(indexPath));
      } else {
        assert.strictEqual(yield* fileSystem.readFileString(indexPath), "invalid index");
      }
    }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
  );
}

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

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
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
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
