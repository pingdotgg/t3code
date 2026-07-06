// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { writeFileAtomic } from "@t3tools/plugin-sdk";

import { FilesystemPathError, makeFilesystemCapability } from "./FilesystemCapability.ts";
import { makePluginWorkspaceGrants } from "../PluginWorkspaceGrants.ts";

const TestLayer = NodeServices.layer;
const layer = it.layer(TestLayer);

const projectShell = (workspaceRoot: string, id = "project-1") =>
  ({
    id,
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  }) as any;

function makeCapability(input: {
  readonly projectRoots: ReadonlyArray<string>;
  readonly grants: any;
}) {
  return makeFilesystemCapability({
    snapshots: {
      getShellSnapshot: () =>
        Effect.succeed({
          projects: input.projectRoots.map((root, index) => projectShell(root, `project-${index}`)),
          threads: [],
        } as any),
    } as any,
    grants: input.grants,
  });
}

const makeTempDir = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix });
  });

const expectPathFailure = <A, E extends Error>(effect: Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.include(String(exit.cause), FilesystemPathError.name);
    }
  });

layer("FilesystemCapability", (it) => {
  it.effect("rejects traversal and absolute relative paths before touching the filesystem", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        yield* expectPathFailure(filesystem.readFileString({ root, relativePath: "../secret" }));
        yield* expectPathFailure(filesystem.exists({ root, relativePath: "/tmp/secret" }));
      }),
    ),
  );

  it.effect("round-trips files, directories, stats, lists, roots, and idempotent remove", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        yield* filesystem.makeDirectory({ root, relativePath: "notes" });
        yield* filesystem.writeFileString({
          root,
          relativePath: "notes/today.txt",
          contents: "hello",
        });
        assert.equal(
          yield* filesystem.readFileString({ root, relativePath: "notes/today.txt" }),
          "hello",
        );
        assert.deepEqual(
          Array.from(yield* filesystem.readFile({ root, relativePath: "notes/today.txt" })),
          Array.from(new TextEncoder().encode("hello")),
        );
        assert.isTrue(yield* filesystem.exists({ root, relativePath: "notes/today.txt" }));
        const stat = yield* filesystem.stat({ root, relativePath: "notes/today.txt" });
        assert.equal(stat.type, "file");
        assert.equal(stat.size, 5);
        assert.isAtLeast(stat.mtime, 0);
        assert.deepEqual(yield* filesystem.listDir({ root, relativePath: "notes" }), [
          { name: "today.txt", relativePath: "notes/today.txt", type: "file" },
        ]);
        assert.deepEqual(
          (yield* filesystem.listDirRecursive({ root, relativePath: "" })).map(
            (entry) => entry.relativePath,
          ),
          ["notes", "notes/today.txt"],
        );
        assert.deepEqual(yield* filesystem.listRoots(), [root]);

        yield* filesystem.remove({ root, relativePath: "notes/today.txt" });
        yield* filesystem.remove({ root, relativePath: "notes/today.txt" });
        assert.isFalse(yield* filesystem.exists({ root, relativePath: "notes/today.txt" }));
      }),
    ),
  );

  it.effect("rejects symlink leaves and symlinked parents for sensitive operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const outside = yield* makeTempDir("plugin-fs-outside-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "no"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(root, "leaf-link")),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, NodePath.join(root, "parent-link"), "dir"),
        );

        yield* expectPathFailure(filesystem.readFileString({ root, relativePath: "leaf-link" }));
        yield* expectPathFailure(
          filesystem.writeFileString({ root, relativePath: "leaf-link", contents: "changed" }),
        );
        yield* expectPathFailure(
          filesystem.makeDirectory({ root, relativePath: "parent-link/created-outside" }),
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(outside, "created-outside"))
              .then(() => true)
              .catch(() => false),
          ),
        );

        yield* filesystem.writeFileString({ root, relativePath: "safe.txt", contents: "safe" });
        yield* expectPathFailure(
          filesystem.rename({
            root,
            fromRelativePath: "safe.txt",
            toRelativePath: "parent-link/safe.txt",
          }),
        );
      }),
    ),
  );

  it.effect("removes recursively without following symlinks outside the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const outside = yield* makeTempDir("plugin-fs-outside-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        yield* filesystem.makeDirectory({ root, relativePath: "nested" });
        yield* filesystem.writeFileString({
          root,
          relativePath: "nested/inside.txt",
          contents: "inside",
        });
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(outside, "keep.txt"), "keep"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(outside, "keep.txt"), NodePath.join(root, "nested", "out")),
        );

        yield* filesystem.remove({ root, relativePath: "nested" });

        assert.isFalse(yield* filesystem.exists({ root, relativePath: "nested" }));
        assert.equal(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(outside, "keep.txt"), "utf8")),
          "keep",
        );
      }),
    ),
  );

  it.effect("fails exclusive create, no-overwrite rename, and read/write caps", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        yield* filesystem.createFileExclusive({ root, relativePath: "one.txt", contents: "one" });
        assert.equal(
          (yield* Effect.exit(
            filesystem.createFileExclusive({ root, relativePath: "one.txt", contents: "two" }),
          ))._tag,
          "Failure",
        );
        yield* filesystem.writeFileString({ root, relativePath: "two.txt", contents: "two" });
        assert.equal(
          (yield* Effect.exit(
            filesystem.rename({ root, fromRelativePath: "one.txt", toRelativePath: "two.txt" }),
          ))._tag,
          "Failure",
        );

        const tooLarge = "x".repeat(16 * 1024 * 1024 + 1);
        assert.equal(
          (yield* Effect.exit(
            filesystem.writeFileString({ root, relativePath: "large.txt", contents: tooLarge }),
          ))._tag,
          "Failure",
        );
        yield* filesystem.writeFileString({ root, relativePath: "small.txt", contents: "abcdef" });
        assert.equal(
          yield* filesystem.readFileStringCapped({
            root,
            relativePath: "small.txt",
            maxBytes: 3,
          }),
          "abc",
        );
      }),
    ),
  );

  it.effect(
    "rename overwrite replaces an existing destination and writeFileAtomic updates in place",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDir("plugin-fs-root-");
          const grants = yield* makePluginWorkspaceGrants;
          const filesystem = makeCapability({ projectRoots: [root], grants });

          // With overwrite:true, a rename atomically replaces an existing file
          // instead of being rejected as "destination already exists".
          yield* filesystem.writeFileString({ root, relativePath: "src.txt", contents: "src" });
          yield* filesystem.writeFileString({ root, relativePath: "dst.txt", contents: "old" });
          yield* filesystem.rename({
            root,
            fromRelativePath: "src.txt",
            toRelativePath: "dst.txt",
            overwrite: true,
          });
          assert.equal(yield* filesystem.readFileString({ root, relativePath: "dst.txt" }), "src");
          assert.isFalse(yield* filesystem.exists({ root, relativePath: "src.txt" }));

          // writeFileAtomic must succeed MORE THAN ONCE for the same path: the
          // second call renames its temp file over the now-existing target. Without
          // overwrite support the helper worked exactly once per path and every
          // subsequent atomic update failed (the M3 regression).
          yield* writeFileAtomic(filesystem, { root, relativePath: "notes.md", contents: "first" });
          assert.equal(
            yield* filesystem.readFileString({ root, relativePath: "notes.md" }),
            "first",
          );
          yield* writeFileAtomic(filesystem, {
            root,
            relativePath: "notes.md",
            contents: "second",
          });
          assert.equal(
            yield* filesystem.readFileString({ root, relativePath: "notes.md" }),
            "second",
          );
        }),
      ),
  );

  it.effect("grants worktree roots after VCS creation and rejects them after removal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectRoot = yield* makeTempDir("plugin-fs-project-");
        const worktreeRoot = yield* makeTempDir("plugin-fs-worktree-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [projectRoot], grants });

        yield* filesystem.writeFileString({
          root: projectRoot,
          relativePath: "project.txt",
          contents: "project",
        });
        yield* expectPathFailure(
          filesystem.writeFileString({
            root: worktreeRoot,
            relativePath: "worktree.txt",
            contents: "denied",
          }),
        );

        yield* grants.grant(worktreeRoot);
        yield* filesystem.writeFileString({
          root: worktreeRoot,
          relativePath: "worktree.txt",
          contents: "allowed",
        });
        assert.deepEqual(
          (yield* filesystem.listRoots()).toSorted(),
          [projectRoot, worktreeRoot].toSorted(),
        );

        yield* grants.revoke(worktreeRoot);
        yield* expectPathFailure(
          filesystem.readFileString({ root: worktreeRoot, relativePath: "worktree.txt" }),
        );
      }),
    ),
  );

  it.effect("keeps resolved out-of-root paths out of plugin-facing messages AND error data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const outside = yield* makeTempDir("plugin-fs-outside-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });
        const outsideFile = NodePath.join(outside, "secret.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(outsideFile, "no"));
        yield* Effect.promise(() => NodeFSP.symlink(outsideFile, NodePath.join(root, "link")));

        const error = yield* filesystem
          .readFileString({ root, relativePath: "link" })
          .pipe(Effect.flip);
        const realOutsideFile = yield* Effect.promise(() => NodeFSP.realpath(outsideFile));

        assert.equal((error as any).reason, "path resolves outside root");
        assert.notInclude(error.message, outsideFile);
        // The structured error payload must not leak the symlink-escape
        // target (host filesystem topology) either: `data` is omitted for
        // outside-root denials.
        assert.isUndefined((error as any).data);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.notInclude(JSON.stringify(error), realOutsideFile);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.notInclude(JSON.stringify(error), outside);
      }),
    ),
  );

  it.effect("treats dangling and out-of-root symlinks as non-existent in exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const outside = yield* makeTempDir("plugin-fs-outside-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        // Dangling symlink: the target never existed. `exists` must report
        // plain non-existence, not throw a path error.
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(root, "missing-target"), NodePath.join(root, "dangling")),
        );
        assert.isFalse(yield* filesystem.exists({ root, relativePath: "dangling" }));

        // Out-of-root symlink: the live target must read as absent — exists
        // must not confirm host paths outside the granted root.
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(outside, "real.txt"), "x"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(outside, "real.txt"), NodePath.join(root, "escape")),
        );
        assert.isFalse(yield* filesystem.exists({ root, relativePath: "escape" }));

        // A live in-root symlink still reads as existing.
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "target.txt"), "x"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(root, "target.txt"), NodePath.join(root, "alias")),
        );
        assert.isTrue(yield* filesystem.exists({ root, relativePath: "alias" }));
      }),
    ),
  );

  it.effect("coerces a NaN readFileStringCapped maxBytes to zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDir("plugin-fs-root-");
        const grants = yield* makePluginWorkspaceGrants;
        const filesystem = makeCapability({ projectRoots: [root], grants });

        yield* filesystem.writeFileString({ root, relativePath: "data.txt", contents: "abcdef" });
        assert.equal(
          yield* filesystem.readFileStringCapped({
            root,
            relativePath: "data.txt",
            maxBytes: Number.NaN,
          }),
          "",
        );
      }),
    ),
  );
});
