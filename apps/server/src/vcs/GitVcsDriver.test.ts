import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it, vi } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

    assert.deepInclude(observedEnv, {
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

for (const [platform, countKey] of [
  ["win32", "GIT_CONFIG_COUNT"],
  ["win32", "git_config_count"],
  ["linux", "GIT_CONFIG_COUNT"],
] as const) {
  it.effect(`GitVcsDriver applies long path configuration for ${platform} with ${countKey}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const readConfig = Effect.fn("readConfig")(function* (key: string) {
        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.longpaths",
          cwd,
          args: ["config", "--get", key],
          env: {
            [countKey]: "2",
            GIT_CONFIG_KEY_0: "user.name",
            GIT_CONFIG_VALUE_0: "inherited-name",
            GIT_CONFIG_KEY_1: "core.longpaths",
            GIT_CONFIG_VALUE_1: "false",
            GIT_CONFIG_KEY_2: "user.name",
            GIT_CONFIG_VALUE_2: "outside-count",
          },
        });
        return result.stdout.trim();
      });

      assert.equal(yield* readConfig("core.longpaths"), platform === "win32" ? "true" : "false");
      assert.equal(yield* readConfig("user.name"), "inherited-name");
    }).pipe(Effect.provide(GitContractLayer), Effect.provideService(HostProcessPlatform, platform)),
  );
}

it.effect("captures and restores checkpoints with paths beyond MAX_PATH", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
        vi.stubEnv(`GIT_CONFIG_KEY_${count}`, "core.longpaths");
        vi.stubEnv(`GIT_CONFIG_VALUE_${count}`, "false");
        vi.stubEnv("GIT_CONFIG_COUNT", String(count + 1));
      }),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    yield* driver.initRepository({ cwd });
    const filePath = path.join(
      cwd,
      ...Array.from({ length: 6 }, () => "nested-".repeat(6)),
      "file.txt",
    );
    assert.isAbove(filePath.length, 260);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, "checkpoint content\n");

    const input = { cwd, checkpointRef: CheckpointRef.make("refs/t3/checkpoints/longpaths") };
    yield* driver.checkpoints.captureCheckpoint(input);
    yield* fileSystem.writeFileString(filePath, "changed content\n");
    assert.isTrue(yield* driver.checkpoints.restoreCheckpoint(input));
    assert.equal(yield* fileSystem.readFileString(filePath), "checkpoint content\n");
  }).pipe(Effect.provide(GitContractLayer), Effect.provideService(HostProcessPlatform, "win32")),
);
