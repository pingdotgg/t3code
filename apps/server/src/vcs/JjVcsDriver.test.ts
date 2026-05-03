import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vitest";

import type { VcsError } from "@t3tools/contracts";
import type { VcsProcessInput, VcsProcessOutput } from "./VcsProcess.ts";
import { VcsProcess, layer as VcsProcessLayer } from "./VcsProcess.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const JjContractLayer = JjVcsDriver.vcsLayer.pipe(
  Layer.provideMerge(VcsProcessLayer),
  Layer.provideMerge(NodeServices.layer),
);

const commandCalls = (calls: ReadonlyArray<VcsProcessInput>) =>
  calls.map((call) => [call.command].concat(call.args));

const processOutput = (stdout: string, exitCode = 0, stderr = ""): VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const runJj = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess;
    yield* process.run({
      operation: "JjVcsDriver.contract.jj",
      command: "jj",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type JjContractError = PlatformError.PlatformError | VcsError;

runVcsDriverContractSuite<VcsProcess, JjContractError>({
  name: "JJ",
  kind: "jj",
  layer: JjContractLayer,
  fixture: {
    createRepo: (cwd) => runJj(cwd, ["git", "init", "--colocate"]),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

describe("JjVcsDriver", () => {
  it.effect("detects repository identity with jj root", () => {
    const calls: VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const identity = yield* driver.detectRepository("/repo/src");

      assert.equal(identity?.kind, "jj");
      assert.equal(identity?.rootPath, "/repo");
      assert.equal(identity?.metadataPath, "/repo/.jj");
      assert.deepStrictEqual(commandCalls(calls), [["jj", "--no-pager", "root"]]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return processOutput("/repo\n");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("lists workspace files using jj file list", () => {
    let observedInput: VcsProcessInput | null = null;

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const result = yield* driver.listWorkspaceFiles("/repo");

      assert.deepStrictEqual(result.paths, ["README.md", "src/index.ts"]);
      assert.deepStrictEqual(observedInput?.args, ["--no-pager", "file", "list"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                observedInput = input;
                return processOutput("README.md\nsrc/index.ts\n");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("filters paths with the git ignore oracle", () => {
    const calls: VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const result = yield* driver.filterIgnoredPaths("/repo", [
        "keep.ts",
        "debug.log",
        "src/index.ts",
      ]);

      assert.deepStrictEqual(result, ["keep.ts", "src/index.ts"]);
      assert.equal(calls[0]?.command, "git");
      assert.deepStrictEqual(calls[0]?.args.slice(-2), ["init", "--bare"]);
      assert.equal(calls[1]?.command, "git");
      assert.deepStrictEqual(calls[1]?.args.slice(-4), [
        "check-ignore",
        "--no-index",
        "-z",
        "--stdin",
      ]);
      assert.equal(calls[1]?.stdin, "keep.ts\0debug.log\0src/index.ts\0");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                if (input.command === "git" && input.args.includes("check-ignore")) {
                  return processOutput("debug.log\0");
                }
                return processOutput("");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("forwards execute env to the VCS process", () => {
    let observedEnv: NodeJS.ProcessEnv | undefined;

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();

      yield* driver.execute({
        operation: "JjVcsDriver.test.env",
        cwd: "/repo",
        args: ["status"],
        env: {
          JJ_CONFIG: "/tmp/t3-jj-config.toml",
        },
      });

      assert.deepStrictEqual(observedEnv, {
        JJ_CONFIG: "/tmp/t3-jj-config.toml",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                observedEnv = input.env;
                return processOutput("");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });
});
