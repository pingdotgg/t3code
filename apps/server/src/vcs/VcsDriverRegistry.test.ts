import { assert, it, describe } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

const DETECT_COMMAND = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

describe("VcsDriverRegistry", () => {
  // resolveSymlinks makes the fake discover from the physical directory, as Git does.
  const makeDiskBackedLayer = (rootDir: string, calls: string[], resolveSymlinks = false) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              const root = resolveSymlinks ? yield* fs.realPath(rootDir) : rootDir;
              let repoDir: string | null = resolveSymlinks
                ? yield* fs.realPath(input.cwd)
                : input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === root ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === DETECT_COMMAND) {
                return processOutput(
                  `true\n${repoDir}\n${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`,
                );
              }
              return processOutput("");
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              Effect.orDie,
            ),
        }),
      ),
    );

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const projectDir = path.join(parentDir, "project");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(projectDir);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: projectDir }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(projectDir, ".git"));

        assert.equal(
          (yield* registry.detect({ cwd: projectDir }))?.repository.rootPath,
          projectDir,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reuses a negative lookup while no .git entry appears", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: projectDir }), null);
        assert.equal(yield* registry.detect({ cwd: projectDir }), null);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 1);
      }).pipe(Effect.provide(makeDiskBackedLayer(projectDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "detects git init above the target of a symlinked project after a negative lookup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
        const outerDir = path.join(parentDir, "outer");
        const projectLink = path.join(parentDir, "link");
        yield* fs.makeDirectory(path.join(outerDir, "target"), { recursive: true });
        yield* fs.symlink(path.join(outerDir, "target"), projectLink);
        const calls: string[] = [];

        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          assert.equal(yield* registry.detect({ cwd: projectLink }), null);

          yield* fs.makeDirectory(path.join(outerDir, ".git"));

          assert.equal(
            (yield* registry.detect({ cwd: projectLink }))?.repository.rootPath,
            yield* fs.realPath(outerDir),
          );
        }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls, true)));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  const makeFailingLayer = (detectOutput: VcsProcess.VcsProcessOutput) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            normalizeGitArgs(input.args).join(" ") === DETECT_COMMAND
              ? Effect.succeed(detectOutput)
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "fatal: bad config line 1 in file .git/config",
                  }),
                ),
        }),
      ),
    );

  it.effect("reads only a failed work-tree probe as no repository", () =>
    Effect.gen(function* () {
      const probeFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(
          makeFailingLayer({
            ...processOutput(""),
            exitCode: ChildProcessSpawner.ExitCode(128),
            stderr: "fatal: bad config line 1 in file .git/config",
          }),
        ),
      );
      assert.equal(probeFailure, null);

      // A newline in the root path makes detection ask for it again, and main surfaced that failure.
      const fallbackFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(makeFailingLayer(processOutput("true\n/re\npo\n.git\n"))),
        Effect.flip,
      );
      assert.equal(fallbackFailure._tag, "VcsProcessExitError");
    }),
  );
});
