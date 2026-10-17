import { assert, it, describe } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import type * as JjRepo from "./JjRepo.ts";
import { describeJj, seedJjRepo } from "./testing/JjTestSupport.ts";

const detection = vi.hoisted(() => ({ enabled: false }));
vi.mock("./JjRepo.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof JjRepo>()),
  get JJ_REPOSITORY_DETECTION_ENABLED() {
    return detection.enabled;
  },
}));

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
      Layer.provide(JjVcsDriver.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(NodeServices.layer),
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

  const makeDiskBackedLayer = (rootDir: string, calls: string[]) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(JjVcsDriver.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(NodeServices.layer),
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

  for (const enabled of [false, true]) {
    it.effect(
      `skips plain Git facade detection without spawning processes (enabled=${enabled})`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-facade-" });
          yield* fs.makeDirectory(path.join(root, ".git"));
          const calls: string[] = [];
          detection.enabled = enabled;
          yield* Effect.gen(function* () {
            const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
            assert.isNull(yield* registry.detect({ cwd: root, jjOnly: true }));
            assert.isEmpty(calls);
          }).pipe(
            Effect.provide(makeDiskBackedLayer(root, calls)),
            Effect.ensuring(
              Effect.sync(() => {
                detection.enabled = false;
              }),
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  describeJj("facade jj detection", () => {
    it.effect("selects a real jj repository when detection is enabled", () =>
      Effect.gen(function* () {
        const { root } = yield* seedJjRepo({ prefix: "t3-vcs-facade-jj-" });
        detection.enabled = true;
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          assert.equal((yield* registry.detect({ cwd: root, jjOnly: true }))?.kind, "jj");
        }).pipe(
          Effect.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
          Effect.ensuring(
            Effect.sync(() => {
              detection.enabled = false;
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
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
