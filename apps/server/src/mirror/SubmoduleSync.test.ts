// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as GitSync from "./GitSync.ts";
import { diffGitlinks, discoverAllGitlinks, MIRROR_SUBMODULE_MAX_DEPTH } from "./SubmoduleSync.ts";
import * as ProcessRunner from "../processRunner.ts";

const GitSyncTestLayer = GitSync.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "mirror-submodule-sync-test-",
    });
    return yield* fileSystem.realPath(dir);
  });
}

function git(cwd: string, args: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "git",
      args,
      cwd,
      timeout: "30 seconds",
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    if (result.code !== 0) {
      return yield* Effect.die(
        new Error(`git ${args.join(" ")} failed (${String(result.code)}): ${result.stderr}`),
      );
    }
    return result.stdout.trim();
  });
}

/**
 * A well-formed but arbitrary commit oid, used as a stand-in gitlink target:
 * `diffGitlinks` never dereferences it (that only happens once the caller
 * actually mirrors the path), it only compares oid strings.
 */
const FAKE_OID_A = "a".repeat(40);
const FAKE_OID_B = "b".repeat(40);
const FAKE_OID_C = "c".repeat(40);

/** Build a tree containing the given gitlink entries, via a throwaway index. */
function buildTreeWithGitlinks(cwd: string, links: ReadonlyArray<{ path: string; oid: string }>) {
  return Effect.gen(function* () {
    yield* git(cwd, ["read-tree", "--empty"]);
    if (links.length > 0) {
      const runner = yield* ProcessRunner.ProcessRunner;
      const indexInfo = links.map((link) => `160000 ${link.oid}\t${link.path}`).join("\n");
      const result = yield* runner.run({
        command: "git",
        args: ["update-index", "--index-info"],
        cwd,
        stdin: `${indexInfo}\n`,
        timeout: "30 seconds",
      });
      if (result.code !== 0) {
        return yield* Effect.die(new Error(`git update-index failed: ${result.stderr}`));
      }
    }
    return yield* git(cwd, ["write-tree"]);
  });
}

it.layer(GitSyncTestLayer)("SubmoduleSync", (it) => {
  describe("diffGitlinks", () => {
    it.effect("classifies added, changed, removed, and unchanged gitlinks", () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir();
        yield* git(repo, ["init", "--initial-branch=main"]);

        const baseTree = yield* buildTreeWithGitlinks(repo, [
          { path: "vendor/unchanged", oid: FAKE_OID_A },
          { path: "vendor/changed", oid: FAKE_OID_A },
          { path: "vendor/removed", oid: FAKE_OID_A },
        ]);
        const targetTree = yield* buildTreeWithGitlinks(repo, [
          { path: "vendor/unchanged", oid: FAKE_OID_A },
          { path: "vendor/changed", oid: FAKE_OID_B },
          { path: "vendor/added", oid: FAKE_OID_C },
        ]);

        const diff = yield* diffGitlinks(repo, baseTree, targetTree);
        const byPath = new Map(diff.map((entry) => [entry.path, entry]));

        expect(byPath.has("vendor/unchanged")).toBe(false);
        expect(byPath.get("vendor/changed")).toEqual({
          path: "vendor/changed",
          baseOid: FAKE_OID_A,
          targetOid: FAKE_OID_B,
          status: "changed",
        });
        expect(byPath.get("vendor/removed")).toEqual({
          path: "vendor/removed",
          baseOid: FAKE_OID_A,
          targetOid: null,
          status: "removed",
        });
        expect(byPath.get("vendor/added")).toEqual({
          path: "vendor/added",
          baseOid: null,
          targetOid: FAKE_OID_C,
          status: "added",
        });
      }),
    );

    it.effect("reports every gitlink as added when there is no base tree", () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir();
        yield* git(repo, ["init", "--initial-branch=main"]);
        const targetTree = yield* buildTreeWithGitlinks(repo, [
          { path: "vendor/lib", oid: FAKE_OID_A },
        ]);

        const diff = yield* diffGitlinks(repo, null, targetTree);
        expect(diff).toEqual([
          { path: "vendor/lib", baseOid: null, targetOid: FAKE_OID_A, status: "added" },
        ]);
      }),
    );
  });

  describe("discoverAllGitlinks", () => {
    it.effect("finds gitlinks at the top level and respects the depth cap", () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir();
        yield* git(repo, ["init", "--initial-branch=main"]);
        const tree = yield* buildTreeWithGitlinks(repo, [
          { path: "vendor/lib", oid: FAKE_OID_A },
          { path: "vendor/other", oid: FAKE_OID_B },
        ]);

        const found = yield* discoverAllGitlinks(repo, tree);
        expect(found).toEqual([
          { path: "vendor/lib", oid: FAKE_OID_A, depth: 0 },
          { path: "vendor/other", oid: FAKE_OID_B, depth: 0 },
        ]);

        const atCap = yield* discoverAllGitlinks(repo, tree, MIRROR_SUBMODULE_MAX_DEPTH);
        expect(atCap).toEqual([]);
      }),
    );
  });
});
