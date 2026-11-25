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
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => Effect.succeed(processOutput("")),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("auto-detects a colocated workspace as jj, ahead of git, without a subprocess", () => {
    let processCalls = 0;
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.sync(() => {
              processCalls += 1;
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const created = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-registry-" });
      const root = yield* fileSystem.realPath(created);
      yield* fileSystem.makeDirectory(path.join(root, ".jj", "repo"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });

      assert.strictEqual((yield* registry.get("jj")).capabilities.kind, "jj");

      const detected = yield* registry.detect({ cwd: root });
      assert.strictEqual(detected?.kind, "jj");
      assert.strictEqual(detected?.repository.rootPath, root);
      assert.strictEqual(processCalls, 0);
    }).pipe(Effect.provide(layer));
  });

  // Answers detection like git: the nearest folder at or above the cwd, up to
  // `rootDir`, that holds `.git` is the repository.
  const makeDiskBackedLayer = (rootDir: string, calls: string[]) =>
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
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
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
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        for (const [repoRel, cwdRel] of [
          ["project", "project"],
          ["..cache", path.join("..cache", "sub")],
        ] as const) {
          const nestedRepoDir = path.join(parentDir, repoRel);
          const cwd = path.join(parentDir, cwdRel);
          yield* fs.makeDirectory(cwd, { recursive: true });

          assert.equal((yield* registry.detect({ cwd }))?.repository.rootPath, parentDir);

          yield* fs.makeDirectory(path.join(nestedRepoDir, ".git"));

          assert.equal((yield* registry.detect({ cwd }))?.repository.rootPath, nestedRepoDir);
        }
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
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
