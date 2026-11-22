import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { referenceRepos, type ReferenceRepo } from "./lib/reference-repos.ts";
import {
  applyReferenceRepoSync,
  planReferenceRepoSync,
  resolveReferenceRepoRef,
  stripReferenceRepoLockfiles,
} from "./sync-reference-repos.ts";

const effectRepo = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;

const runGit = Effect.fn("test.runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make("git", [...args], { cwd }));
});

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves reference tags from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  alchemy: 2.0.0-beta.84\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectRepo, rootDir, false),
        "effect@4.0.0-beta.73",
      );
      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.84");
    }),
  );

  it.effect("plans a shallow, tagless clone of the resolved ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const plan = yield* planReferenceRepoSync(effectRepo, rootDir, false);
      assert.equal(plan.ref, "effect@4.0.0-beta.73");
      assert.deepStrictEqual(plan.cloneArgs, [
        "clone",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--single-branch",
        "--branch=effect@4.0.0-beta.73",
        "https://github.com/Effect-TS/effect.git",
      ]);
    }),
  );

  it.effect(
    "strips root and nested lockfiles while preserving non-lockfiles and symlink safety",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "sync-reference-repos-strip-",
        });
        const checkoutDir = path.join(baseDir, "checkout");
        const externalDir = path.join(baseDir, "external");

        yield* fs.makeDirectory(path.join(checkoutDir, "packages/a/fixtures"), { recursive: true });
        yield* fs.makeDirectory(path.join(checkoutDir, "pnpm-lock.yaml"), { recursive: true });
        yield* fs.makeDirectory(externalDir, { recursive: true });

        const removedFiles = [
          path.join(checkoutDir, "package-lock.json"),
          path.join(checkoutDir, "packages/a/pnpm-lock.yaml"),
          path.join(checkoutDir, "packages/a/fixtures/yarn.lock"),
          path.join(checkoutDir, "packages/a/fixtures/bun.lock"),
          path.join(checkoutDir, "packages/a/fixtures/Cargo.lock"),
          path.join(checkoutDir, "packages/a/fixtures/pylock.ci.toml"),
          path.join(checkoutDir, "pnpm-lock.yaml/Pipfile.lock"),
        ];
        const preservedFiles = [
          path.join(checkoutDir, "package.json"),
          path.join(checkoutDir, "flake.lock"),
          path.join(checkoutDir, "go.sum"),
          path.join(checkoutDir, "packages/a/index.ts"),
          path.join(checkoutDir, "packages/a/fixtures/lock-holder.ts"),
          path.join(checkoutDir, "packages/a/fixtures/pylock.ci.example.toml"),
          path.join(checkoutDir, "pnpm-lock.yaml/keep.txt"),
          path.join(externalDir, "pnpm-lock.yaml"),
          path.join(externalDir, "target.txt"),
        ];

        for (const file of [...removedFiles, ...preservedFiles]) {
          yield* fs.writeFileString(file, "content\n");
        }

        const dirSymlink = path.join(checkoutDir, "external-link");
        const loopSymlink = path.join(checkoutDir, "packages/self-loop");
        const lockfileSymlink = path.join(checkoutDir, "packages/yarn.lock");
        if (symlinksSupported) {
          yield* fs.symlink(externalDir, dirSymlink);
          yield* fs.symlink(checkoutDir, loopSymlink);
          yield* fs.symlink(path.join(externalDir, "target.txt"), lockfileSymlink);
        }

        yield* stripReferenceRepoLockfiles(checkoutDir);

        for (const file of removedFiles) {
          assert.equal(yield* fs.exists(file), false, `expected ${file} to be removed`);
        }
        if (symlinksSupported) {
          assert.equal(
            yield* fs.exists(lockfileSymlink),
            false,
            "expected lockfile symlink removal",
          );
        }

        for (const file of preservedFiles) {
          assert.equal(yield* fs.exists(file), true, `expected ${file} to be preserved`);
        }
        if (symlinksSupported) {
          assert.equal(yield* fs.exists(dirSymlink), true, "expected directory symlink to remain");
          assert.equal(yield* fs.exists(loopSymlink), true, "expected loop symlink to remain");
        }
      }),
  );

  it.effect("falls back to lstat when directory entries report Unknown type", () =>
    Effect.gen(function* () {
      const baseFs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* baseFs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-unknown-",
      });
      const checkoutDir = path.join(baseDir, "checkout");
      const externalDir = path.join(baseDir, "external");

      yield* baseFs.makeDirectory(path.join(checkoutDir, "nested"), { recursive: true });
      yield* baseFs.makeDirectory(externalDir, { recursive: true });
      yield* baseFs.writeFileString(path.join(checkoutDir, "nested/pnpm-lock.yaml"), "lock\n");
      yield* baseFs.writeFileString(path.join(checkoutDir, "nested/index.ts"), "export {};\n");
      yield* baseFs.writeFileString(path.join(externalDir, "pnpm-lock.yaml"), "external\n");
      if (symlinksSupported) {
        yield* baseFs.symlink(externalDir, path.join(checkoutDir, "external-link"));
      }

      const unknownTypeFs = FileSystem.FileSystem.of({
        ...baseFs,
        readDirectoryEntries: (directory) =>
          baseFs
            .readDirectoryEntries(directory)
            .pipe(
              Effect.map((entries) =>
                entries.map((entry) => ({ name: entry.name, type: "Unknown" as const })),
              ),
            ),
      });

      yield* stripReferenceRepoLockfiles(checkoutDir).pipe(
        Effect.provideService(FileSystem.FileSystem, unknownTypeFs),
      );

      assert.equal(yield* baseFs.exists(path.join(checkoutDir, "nested/pnpm-lock.yaml")), false);
      assert.equal(yield* baseFs.exists(path.join(checkoutDir, "nested/index.ts")), true);
      assert.equal(yield* baseFs.exists(path.join(externalDir, "pnpm-lock.yaml")), true);
    }),
  );

  it.effect("applyReferenceRepoSync strips lockfiles before committing .repos/<id>", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-apply-",
      });
      const emptyConfig = path.join(baseDir, "empty.gitconfig");
      const emptyHooksDir = path.join(baseDir, "empty-hooks");
      const upstreamDir = path.join(baseDir, "upstream");
      const workspaceDir = path.join(baseDir, "workspace");

      yield* fs.writeFileString(emptyConfig, "");
      yield* fs.makeDirectory(emptyHooksDir, { recursive: true });
      yield* fs.makeDirectory(path.join(upstreamDir, "packages/fixture"), { recursive: true });
      yield* fs.makeDirectory(workspaceDir, { recursive: true });

      const fixtureConfig = {
        "core.excludesFile": emptyConfig,
        "core.hooksPath": emptyHooksDir,
        "commit.gpgsign": "false",
        "user.name": "Test",
        "user.email": "test@example.com",
      };
      const isolatedEnv: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && !entry[0].toUpperCase().startsWith("GIT_"),
          ),
        ),
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
        ...Object.fromEntries(
          Object.entries(fixtureConfig).flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
          ]),
        ),
      };
      const isolatedSpawner = ChildProcessSpawner.make((command) =>
        baseSpawner.spawn(ChildProcess.setEnv(command, isolatedEnv)),
      );

      yield* fs.writeFileString(path.join(upstreamDir, "pnpm-lock.yaml"), "root lock\n");
      yield* fs.writeFileString(
        path.join(upstreamDir, "packages/fixture/package-lock.json"),
        "{}\n",
      );
      yield* fs.writeFileString(path.join(upstreamDir, "README.md"), "# Upstream\n");
      yield* fs.writeFileString(
        path.join(upstreamDir, "packages/fixture/index.ts"),
        "export {};\n",
      );

      yield* Effect.gen(function* () {
        yield* runGit(upstreamDir, ["init", "--initial-branch=main"]);
        yield* runGit(upstreamDir, ["add", "."]);
        yield* runGit(upstreamDir, ["commit", "-m", "initial"]);

        const upstreamTree = (yield* runGit(upstreamDir, ["ls-tree", "-r", "--name-only", "HEAD"]))
          .trim()
          .split("\n")
          .sort();
        assert.deepStrictEqual(upstreamTree, [
          "README.md",
          "packages/fixture/index.ts",
          "packages/fixture/package-lock.json",
          "pnpm-lock.yaml",
        ]);

        yield* runGit(workspaceDir, ["init", "--initial-branch=main"]);

        const repo: ReferenceRepo = {
          id: "sample",
          prefix: ".repos/sample",
          repository: upstreamDir,
          latestRef: "main",
          versionSourcePath: "pnpm-workspace.yaml",
          packageVersionPath: ["catalog", "sample"],
          versionTagPrefix: "v",
        };

        const upstreamUrl = (yield* path.toFileUrl(upstreamDir)).href;
        yield* applyReferenceRepoSync(workspaceDir, {
          repo,
          ref: "main",
          cloneArgs: [
            "clone",
            "--quiet",
            "--depth=1",
            "--no-tags",
            "--single-branch",
            "--branch=main",
            upstreamUrl,
          ],
        });

        const committedTree = (yield* runGit(workspaceDir, [
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
          "--",
          repo.prefix,
        ]))
          .trim()
          .split("\n")
          .sort();
        assert.deepStrictEqual(committedTree, [
          ".repos/sample/README.md",
          ".repos/sample/packages/fixture/index.ts",
        ]);
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, isolatedSpawner));
    }),
  );
});
