import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { T3ProjectFile } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import { makeWorktreeClone } from "./WorktreeClone.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const encodeProject = Schema.encodeSync(Schema.fromJsonString(T3ProjectFile));

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-apfs-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.fn("fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-apfs-" });
  const cwd = path.join(root, "source");
  const target = path.join(root, "target");
  yield* fs.makeDirectory(cwd);
  const git = (directory: string, args: string[]) =>
    driver.execute({ operation: "test", cwd: directory, args });
  const write = Effect.fn("write")(function* (name: string, content: string) {
    const file = path.join(cwd, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  });
  yield* git(cwd, ["init", "--initial-branch=main"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* git(cwd, ["config", "user.email", "test@example.com"]);
  yield* write("source.txt", "original\n");
  yield* write("large.bin", "x".repeat(16 * 1024 * 1024));
  yield* write("nested/a\nb.txt", "newline filename\n");
  yield* write(".gitignore", "node_modules/\n.env\n");
  yield* write("package.json", '{"name":"fixture"}');
  yield* write("package-lock.json", '{"lockfileVersion":3}');
  yield* write("packages/child/package.json", '{"name":"child"}');
  yield* write(
    "t3.json",
    encodeProject({
      worktreeCloneFiles: true,
      worktreeCloneDependencies: true,
      scripts: [{ name: "Install", command: "npm ci", runOnWorktreeCreate: true }],
    }),
  );
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "fixture"]);
  const clone = yield* makeWorktreeClone(driver.execute);
  const claim = () => git(cwd, ["worktree", "add", "--no-checkout", "-b", "feature", target]);
  return { fs, path, driver, cwd, target, git, write, clone, claim };
});

it.layer(TestLayer)("Worktree cloning", (it) => {
  it.effect("does no work on other platforms", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const clone = yield* makeWorktreeClone(f.driver.execute).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      assert.equal(yield* clone.prepare(f.cwd, "HEAD"), null);
      yield* clone.warmDependencies(f.cwd, f.target);
      assert.isFalse(yield* f.fs.exists(f.target));
    }),
  );

  describe.skipIf(HostProcessPlatform.defaultValue() !== "darwin")("macOS", () => {
    it.effect("retains verified clones and isolates edits without copying ignored files", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write(".env", "secret");
        let clonedInode: bigint | number | undefined;
        const clone = yield* makeWorktreeClone((input) =>
          Effect.gen(function* () {
            if (input.args[0] === "reset") {
              const info = yield* f.fs.stat(f.path.join(f.target, "large.bin")).pipe(Effect.orDie);
              clonedInode = info.ino._tag === "Some" ? info.ino.value : undefined;
            }
            return yield* f.driver.execute(input);
          }),
        );
        const plan = yield* clone.prepare(f.cwd, "HEAD");
        assert.isNotNull(plan);
        yield* f.claim();
        assert.isTrue(yield* clone.checkout(plan!, f.target));
        const info = yield* f.fs.stat(f.path.join(f.target, "large.bin"));
        assert.equal(info.ino._tag === "Some" ? info.ino.value : undefined, clonedInode);
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.target, "nested/a\nb.txt")),
          "newline filename\n",
        );
        assert.isFalse(yield* f.fs.exists(f.path.join(f.target, ".env")));
        yield* f.fs.writeFileString(f.path.join(f.target, "source.txt"), "changed");
        assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "source.txt")), "original\n");
      }),
    );

    it.effect("repairs source changes that race with cloning", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const plan = yield* f.clone.prepare(f.cwd, "HEAD");
        assert.isNotNull(plan);
        yield* f.write("source.txt", "racing edit\n");
        yield* f.claim();
        yield* f.clone.checkout(plan!, f.target);
        assert.equal(yield* f.fs.readFileString(f.path.join(f.target, "source.txt")), "original\n");
        assert.equal(yield* f.fs.readFileString(f.path.join(f.cwd, "source.txt")), "racing edit\n");
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
      }),
    );

    it.effect("does not copy stale paths if the target ref advances after planning", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const plan = yield* f.clone.prepare(f.cwd, "HEAD");
        assert.isNotNull(plan);
        yield* f.git(f.cwd, ["rm", "large.bin"]);
        yield* f.git(f.cwd, ["commit", "-m", "remove asset"]);
        yield* f.claim();
        assert.isFalse(yield* f.clone.checkout(plan!, f.target));
        assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "large.bin")));
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
      }),
    );

    it.effect("clones small-file repositories without project configuration by default", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.git(f.cwd, ["rm", "large.bin", "t3.json"]);
        yield* f.git(f.cwd, ["commit", "-m", "small files only"]);
        const plan = yield* f.clone.prepare(f.cwd, "HEAD");
        assert.isNotNull(plan);
        assert.include(plan!.files, "source.txt");
        yield* f.claim();
        assert.isTrue(yield* f.clone.checkout(plan!, f.target));
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
      }),
    );

    it.effect("honors an explicit tracked-file cloning opt-out", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write("t3.json", encodeProject({ worktreeCloneFiles: false }));
        yield* f.git(f.cwd, ["add", "t3.json"]);
        yield* f.git(f.cwd, ["commit", "-m", "disable clones"]);
        assert.equal(yield* f.clone.prepare(f.cwd, "HEAD"), null);
      }),
    );

    it.effect("lets Git materialize tracked symlinks beside cloned regular files", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.symlink("source.txt", f.path.join(f.cwd, "tracked-link"));
        yield* f.git(f.cwd, ["add", "tracked-link"]);
        yield* f.git(f.cwd, ["commit", "-m", "add symlink"]);
        const plan = yield* f.clone.prepare(f.cwd, "HEAD");
        assert.isNotNull(plan);
        assert.notInclude(plan!.files, "tracked-link");
        yield* f.driver.createWorktree({
          cwd: f.cwd,
          path: f.target,
          refName: "main",
          newRefName: "feature",
        });
        assert.equal(yield* f.fs.readLink(f.path.join(f.target, "tracked-link")), "source.txt");
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
      }),
    );

    it.effect("falls back to Git when the filesystem cannot clone", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const clone = yield* makeWorktreeClone(f.driver.execute).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            exitCode: () => Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          }),
        );
        const plan = yield* clone.prepare(f.cwd, "HEAD");
        assert.isNotNull(plan);
        yield* f.claim();
        assert.isFalse(yield* clone.checkout(plan!, f.target));
        assert.equal(yield* f.fs.readFileString(f.path.join(f.target, "source.txt")), "original\n");
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
      }),
    );

    it.effect("skips dirty sources, other commits, filters, sparse checkout and hooks", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write("source.txt", "dirty");
        assert.equal(yield* f.clone.prepare(f.cwd, "HEAD"), null);
        yield* f.git(f.cwd, ["add", "."]);
        yield* f.git(f.cwd, ["commit", "-m", "second"]);
        assert.equal(yield* f.clone.prepare(f.cwd, "HEAD~1"), null);
        for (const [key, value] of [
          ["filter.test.smudge", "cat"],
          ["core.sparseCheckout", "true"],
          ["extensions.worktreeConfig", "true"],
        ]) {
          yield* f.git(f.cwd, ["config", key!, value!]);
          assert.equal(yield* f.clone.prepare(f.cwd, "HEAD"), null);
          yield* f.git(f.cwd, ["config", "--unset", key!]);
        }
        yield* f.write(".git/hooks/post-checkout", "#!/bin/sh\nexit 0\n");
        assert.equal(yield* f.clone.prepare(f.cwd, "HEAD"), null);
      }),
    );

    it.effect("seeds opted-in dependencies and relative links but rebuilds caches and shims", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write("node_modules/pkg/index.js", "module.exports = 1");
        yield* f.write("node_modules/.bin/pkg", "old absolute shim");
        yield* f.write("node_modules/.vite/cache", "old root");
        yield* f.fs.symlink("pkg", f.path.join(f.cwd, "node_modules/alias"));
        yield* f.write("packages/child/node_modules/child-dep/index.js", "child");
        yield* f.driver.createWorktree({
          cwd: f.cwd,
          path: f.target,
          refName: "main",
          newRefName: "feature",
        });
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.target, "node_modules/pkg/index.js")),
          "module.exports = 1",
        );
        assert.equal(yield* f.fs.readLink(f.path.join(f.target, "node_modules/alias")), "pkg");
        assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "node_modules/.bin")));
        assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "node_modules/.vite")));
        assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.bin/pkg")));
        assert.equal(
          yield* f.fs.readFileString(
            f.path.join(f.target, "packages/child/node_modules/child-dep/index.js"),
          ),
          "child",
        );
        yield* f.fs.writeFileString(f.path.join(f.target, "node_modules/pkg/index.js"), "changed");
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.cwd, "node_modules/pkg/index.js")),
          "module.exports = 1",
        );
        assert.equal((yield* f.git(f.target, ["status", "--porcelain"])).stdout, "");
      }),
    );

    it.effect(
      "discards dependency seeds with absolute links and leaves hook-created installs alone",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.write("node_modules/pkg/index.js", "source");
          yield* f.fs.symlink(
            f.path.join(f.cwd, "node_modules/pkg"),
            f.path.join(f.cwd, "node_modules/absolute"),
          );
          yield* f.driver.createWorktree({
            cwd: f.cwd,
            path: f.target,
            refName: "main",
            newRefName: "feature",
          });
          assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "node_modules")));
          assert.isFalse(
            (yield* f.fs.readDirectory(f.target)).some((name) => name.startsWith(".t3-deps-")),
          );
          yield* f.fs.makeDirectory(f.path.join(f.target, "node_modules"));
          yield* f.fs.writeFileString(f.path.join(f.target, "node_modules/marker"), "hook");
          yield* f.clone.warmDependencies(f.cwd, f.target);
          assert.equal(
            yield* f.fs.readFileString(f.path.join(f.target, "node_modules/marker")),
            "hook",
          );
        }),
    );

    it.effect("does not seed dependencies without consent and a setup script", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write("node_modules/pkg/index.js", "source");
        yield* f.git(f.cwd, ["worktree", "add", "-b", "feature", f.target]);
        for (const config of [
          { scripts: [{ name: "Install", command: "npm ci", runOnWorktreeCreate: true }] },
          { worktreeCloneDependencies: true },
        ]) {
          yield* f.fs.writeFileString(f.path.join(f.target, "t3.json"), encodeProject(config));
          yield* f.clone.warmDependencies(f.cwd, f.target);
          assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "node_modules")));
        }
      }),
    );
  });
});
