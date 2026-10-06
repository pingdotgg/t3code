import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

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

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
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
      Layer.provideMerge(NodeServices.layer),
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
      Layer.provide(NodeServices.layer),
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
              if (command === "rev-parse --is-inside-work-tree") return processOutput("true\n");
              if (command === "rev-parse --show-toplevel") return processOutput(`${repoDir}\n`);
              if (command === "rev-parse --git-common-dir") {
                return processOutput(`${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`);
              }
              return processOutput("");
            }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
        }),
      ),
    );

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const first = yield* registry.resolve({ cwd: repoDir, requestedKind: "git" });
        const second = yield* registry.resolve({ cwd: repoDir, requestedKind: "git" });

        assert.equal(first.repository.rootPath, repoDir);
        assert.equal(second.repository.rootPath, repoDir);
        assert.deepStrictEqual(calls, [
          "rev-parse --is-inside-work-tree",
          "rev-parse --show-toplevel",
          "rev-parse --git-common-dir",
        ]);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
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
        assert.equal(calls.filter((call) => call === "rev-parse --is-inside-work-tree").length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detects again when git init creates a repository between the cwd and its root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const middleDir = path.join(parentDir, "a");
      const cwd = path.join(middleDir, "b");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(cwd, { recursive: true });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(middleDir, ".git"));

        assert.equal((yield* registry.detect({ cwd }))?.repository.rootPath, middleDir);
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
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
        assert.equal(calls.filter((call) => call === "rev-parse --is-inside-work-tree").length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
