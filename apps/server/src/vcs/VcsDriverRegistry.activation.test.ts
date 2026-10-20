import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as JjVcsDriver from "./JjVcsDriver.ts";
import { invalidateJjAvailability } from "./JjAvailability.ts";
import { isGitLinkedWorktree } from "./JjRepo.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import { describeJj, runGit, runJj, seedJjRepo } from "./testing/JjTestSupport.ts";

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
  it.effect(
    "auto-detects a colocated workspace as jj, ahead of git, with a cached version probe",
    () => {
      let processCalls = 0;
      const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
        Layer.provide(JjVcsDriver.layer),
        Layer.provide(VcsProjectConfig.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: () =>
              Effect.sync(() => {
                processCalls += 1;
                return processOutput("jj 0.46.0\n");
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
        assert.strictEqual(processCalls, 1);
      }).pipe(Effect.provide(layer));
    },
  );

  const makeDiskBackedLayer = (rootDir: string, calls: string[], failJjDetection = false) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(VcsProjectConfig.layer),
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
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              if (input.command === "jj") return processOutput("jj 0.46.0\n");
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
  it.effect("never routes a nested bare Git repository to the outer jj driver", () =>
    Effect.gen(function* () {
      const { root } = yield* seedJjRepo({ prefix: "t3-jj-nested-bare-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bare = path.join(root, "nested.git");
      yield* fs.makeDirectory(path.join(bare, "objects"), { recursive: true });

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.resolve({ cwd: root })).kind, "jj");
        for (const cwd of [bare, path.join(bare, "objects")]) {
          const handle = yield* registry.detect({ cwd });
          assert.equal(handle?.kind, "jj");
          assert.equal(handle?.repository.rootPath, root);
        }
        yield* runGit(root, ["init", "--bare", bare]);
        for (const cwd of [bare, path.join(bare, "objects")]) {
          assert.isNull(yield* registry.detect({ cwd, jjOnly: true }));
          assert.isNull(yield* registry.detect({ cwd }));
          const refusal = yield* registry.resolve({ cwd }).pipe(Effect.flip);
          assert.equal(refusal._tag, "VcsUnsupportedOperationError");
        }
      }).pipe(Effect.provide(VcsDriverRegistry.layer));
    }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  it.effect("keeps Git available when jj is initialized inside a linked Git worktree", () =>
    Effect.gen(function* () {
      const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-linked-git-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktree = path.join(base, "thread-worktree");
      yield* runGit(root, ["worktree", "add", "-b", "thread", worktree, "HEAD"]);
      yield* runJj(worktree, ["git", "init", "--colocate"]);
      assert.equal((yield* fs.stat(path.join(worktree, ".git"))).type, "File");
      assert.equal((yield* fs.stat(path.join(worktree, ".jj", "repo"))).type, "Directory");
      const nested = path.join(worktree, "nested");
      yield* fs.makeDirectory(nested);
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.resolve({ cwd: nested });
        assert.equal(handle.kind, "git");
        assert.equal(handle.repository.rootPath, worktree);
        assert.include(handle.notice, "Jujutsu inside a Git linked worktree is not supported");
        assert.include(handle.notice, "Using Git");
        assert.notInclude(handle.notice, "colocation enable");
        assert.isTrue(yield* handle.driver.isInsideWorkTree(nested));
      }).pipe(Effect.provide(VcsDriverRegistry.layer));
      const driver = yield* JjVcsDriver.makeJjVcsDriver;
      const refusal = yield* driver
        .ensureUsable("test.pinned-linked-worktree", nested)
        .pipe(Effect.flip);
      if (refusal._tag !== "VcsUnsupportedOperationError") {
        throw new Error(`Unexpected refusal: ${refusal._tag}`);
      }
      assert.include(refusal.detail, "Jujutsu inside a Git linked worktree is not supported");
      assert.notInclude(refusal.detail, "colocation enable");
      const separate = path.join(base, "separate-checkout");
      yield* runGit(base, [
        "init",
        "--separate-git-dir",
        path.join(base, "separate-gitdir"),
        separate,
      ]);
      assert.isFalse(yield* isGitLinkedWorktree(fs, path, separate));
    }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  for (const kind of ["git", "jj", "unknown"] as const) {
    it.effect(`honors the project-file ${kind} pin with unusable jj`, () =>
      Effect.gen(function* () {
        const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-config-pin-", seed: true });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(root, ".t3code"));
        yield* fs.writeFileString(
          path.join(root, ".t3code", "vcs.json"),
          JSON.stringify({ vcs: { kind } }),
        );
        const realProcess = yield* VcsProcess.VcsProcess;
        const process: VcsProcess.VcsProcess["Service"] = {
          run: (input) =>
            realProcess.run({
              ...input,
              command: input.command === "jj" ? path.join(base, "missing-jj") : input.command,
            }),
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const handle = yield* registry.resolve({ cwd: root });
          assert.equal(handle.kind, kind === "jj" ? "jj" : "git");
          if (kind === "unknown") assert.include(handle.notice, "PATH");
          else assert.isUndefined(handle.notice);
          if (kind === "unknown") {
            const requested = yield* registry.resolve({ cwd: root, requestedKind: "unknown" });
            assert.equal(requested.kind, "git");
            assert.include(requested.notice, "PATH");
          }
        }).pipe(
          Effect.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
      }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
    );
  }
  it.effect("falls back to Git with the error rather than a config migration warning", () =>
    Effect.gen(function* () {
      const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-broken-config-", seed: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(root, ".jj", "repo", "config.toml"),
        "this is = = broken\n",
      );
      const realProcess = yield* VcsProcess.VcsProcess;
      let diagnostic = "";
      const process: VcsProcess.VcsProcess["Service"] = {
        run: (input) =>
          realProcess
            .run({
              ...input,
              env: { ...input.env, XDG_CONFIG_HOME: path.join(base, "config") },
            })
            .pipe(
              Effect.tap((output) =>
                Effect.sync(() => {
                  if (input.command === "jj") diagnostic = output.stderr;
                }),
              ),
            ),
      };
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.resolve({ cwd: root });
        assert.equal(handle.kind, "git");
        assert.include(diagnostic, "Config error:");
        assert.include(handle.notice, "Config error:");
        assert.notInclude(handle.notice, "Warning:");
        assert.notInclude(handle.notice, "Hint:");
        assert.notInclude(handle.notice, "\n");
        assert.isTrue(yield* handle.driver.isInsideWorkTree(root));
      }).pipe(
        Effect.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  for (const unavailable of ["missing", "old", "broken", "empty"] as const) {
    it.effect(`selects usable colocated Git only for ${unavailable} and recovers on rescan`, () =>
      Effect.gen(function* () {
        const { root, base } = yield* seedJjRepo({ prefix: "t3-jj-fallback-", seed: true });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const executable = path.join(base, "jj-test");
        if (unavailable !== "missing") {
          yield* fs.writeFileString(
            executable,
            unavailable === "old"
              ? "#!/bin/sh\nprintf 'jj 0.45.0\\n'\n"
              : unavailable === "empty"
                ? "#!/bin/sh\nexit 0\n"
                : "#!/bin/sh\nprintf 'broken config\\n' >&2\nexit 1\n",
          );
          yield* fs.chmod(executable, 0o755);
        }
        const realProcess = yield* VcsProcess.VcsProcess;
        let recovered = false;
        const process: VcsProcess.VcsProcess["Service"] = {
          run: (input) =>
            realProcess.run({
              ...input,
              command: input.command === "jj" && !recovered ? executable : input.command,
            }),
        };
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const pinned = yield* registry.resolve({ cwd: root, requestedKind: "git" });
          assert.equal(pinned.kind, "git");
          assert.isUndefined(pinned.notice);
          const handle = yield* registry.resolve({ cwd: root });
          assert.equal(handle.kind, "git");
          assert.isString(handle.notice);
          if (unavailable === "broken") assert.include(handle.notice, "broken config");
          if (unavailable === "empty") {
            assert.equal(
              handle.notice,
              "Jujutsu could not run: Jujutsu version probe returned an invalid version banner. Using Git for this colocated repository.",
            );
          }
          assert.isTrue(yield* handle.driver.isInsideWorkTree(root));
          const external = yield* seedJjRepo({ prefix: "t3-jj-noncolocated-", colocated: false });
          const noncolocated = yield* registry.resolve({ cwd: external.root });
          assert.equal(noncolocated.kind, "jj");
          assert.isUndefined(noncolocated.notice);
          const driver = yield* JjVcsDriver.JjVcsDriver;
          const unsupported = yield* Effect.result(driver.ensureUsable("test", external.root));
          assert.equal(unsupported._tag, "Failure");
          if (unsupported._tag === "Failure") {
            assert.equal(unsupported.failure._tag, "VcsUnsupportedOperationError");
            if (unsupported.failure._tag === "VcsUnsupportedOperationError") {
              assert.include(
                unsupported.failure.detail,
                "T3 Code supports colocated Jujutsu repositories.",
              );
            }
          }
          recovered = true;
          invalidateJjAvailability(process);
          assert.equal((yield* registry.resolve({ cwd: root })).kind, "jj");
        }).pipe(
          Effect.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provideMerge(
                JjVcsDriver.layer.pipe(
                  Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
                  Layer.provide(NodeServices.layer),
                ),
              ),
              Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
      }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
    );
  }
  for (const symlinkedGitRoot of [false, true]) {
    it.effect(
      `caches unavailable-jj fallback with a canonical Git root (alias=${symlinkedGitRoot})`,
      () =>
        Effect.gen(function* () {
          const { root, base } = yield* seedJjRepo({
            prefix: "t3-jj-fallback-boundary-",
            seed: true,
          });
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const alias = path.join(base, "alias");
          yield* fs.symlink(root, alias);
          const realProcess = yield* VcsProcess.VcsProcess;
          let gitCalls = 0;
          const process: VcsProcess.VcsProcess["Service"] = {
            run: (input) =>
              Effect.gen(function* () {
                if (input.command === "git") gitCalls += 1;
                const output = yield* realProcess.run({
                  ...input,
                  command: input.command === "jj" ? path.join(base, "missing-jj") : input.command,
                });
                return symlinkedGitRoot &&
                  input.command === "git" &&
                  normalizeGitArgs(input.args).join(" ") === "rev-parse --show-toplevel"
                  ? { ...output, stdout: `${alias}\n` }
                  : output;
              }),
          };
          yield* Effect.gen(function* () {
            const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
            const first = yield* registry.resolve({ cwd: alias });
            assert.equal(first.kind, "git");
            assert.isString(first.notice);
            const initialCalls = gitCalls;
            assert.isAbove(initialCalls, 0);
            assert.equal((yield* registry.resolve({ cwd: alias })).kind, "git");
            assert.equal(gitCalls, initialCalls);
          }).pipe(
            Effect.provide(
              VcsDriverRegistry.layer.pipe(
                Layer.provideMerge(
                  JjVcsDriver.layer.pipe(
                    Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
                    Layer.provide(NodeServices.layer),
                  ),
                ),
                Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
        }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
    );
  }
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
