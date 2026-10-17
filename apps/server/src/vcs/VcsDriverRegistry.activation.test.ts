import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import { describeJj, runJj, seedJjRepo } from "./testing/JjTestSupport.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

describe("VcsDriverRegistry activation", () => {
  it.effect("auto-detects a colocated workspace as jj, ahead of git, without a subprocess", () => {
    let processCalls = 0;
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(JjVcsDriver.layer),
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

  const makeDiskBackedLayer = (rootDir: string, calls: string[], failJjDetection = false) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(
        failJjDetection
          ? Layer.mock(JjVcsDriver.JjVcsDriver)({
              capabilities: {
                kind: "jj",
                supportsWorktrees: true,
                supportsBookmarks: true,
                supportsAtomicSnapshot: true,
                supportsPushDefaultRemote: false,
                ignoreClassifier: "git-compatible-fallback",
              },
              detectRepository: () =>
                Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "test.detect",
                    kind: "jj",
                    detail: "Jujutsu marker lookup failed.",
                  }),
                ),
            })
          : JjVcsDriver.layer,
      ),
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

  it.effect("falls back to Git when the added jj probe fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.detect({ cwd: repoDir });
        assert.equal(handle?.kind, "git");
        assert.equal(handle?.repository.rootPath, repoDir);
        assert.deepStrictEqual(calls, [
          "rev-parse --is-inside-work-tree",
          "rev-parse --show-toplevel",
          "rev-parse --git-common-dir",
        ]);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls, true)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("detects Jujutsu initialized at a cached Git root from a nested cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const cwd = path.join(repoDir, "src");
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      yield* fs.makeDirectory(cwd);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd }))?.kind, "git");

        yield* fs.makeDirectory(path.join(repoDir, ".jj", "repo"), { recursive: true });

        assert.equal((yield* registry.detect({ cwd }))?.kind, "jj");
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describeJj("VcsDriverRegistry shared jj driver", () => {
  it.effect(
    "refreshes registry review refs after the workflow driver invalidates remote caches",
    () =>
      Effect.gen(function* () {
        const { root } = yield* seedJjRepo({ prefix: "t3-jj-registry-cache-", withRemote: true });
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const workflowDriver = yield* JjVcsDriver.JjVcsDriver;
        const { driver } = yield* registry.resolve({ cwd: root });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(root, "review.txt"), "shared cache\n");
        if (driver.getDiffPreview === undefined) {
          assert.fail("The jj registry driver must expose review previews.");
        }

        const before = yield* driver.getDiffPreview({ cwd: root, baseRef: "origin/main" });
        const beforeBase = before.sources.find((source) => source.kind === "branch-range");
        assert.isString(beforeBase?.baseRef);
        assert.include(beforeBase?.diff ?? "", "+shared cache");
        assert.deepStrictEqual(yield* workflowDriver.listRemoteNames(root), ["origin"]);

        yield* runJj(root, ["git", "remote", "rename", "origin", "upstream"]);
        yield* workflowDriver.invalidateRepoCaches(root);

        const after = yield* driver.getDiffPreview({ cwd: root, baseRef: "upstream/main" });
        const afterBase = after.sources.find((source) => source.kind === "branch-range");
        assert.strictEqual(afterBase?.baseRef, beforeBase?.baseRef);
        assert.strictEqual(afterBase?.diff, beforeBase?.diff);
        assert.deepStrictEqual(yield* workflowDriver.listRemoteNames(root), ["upstream"]);
      }).pipe(
        Effect.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provideMerge(JjVcsDriver.layer),
            Layer.provide(VcsProcess.layer),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
});
