// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect FileSystem lacks lstat and explicit directory-symlink types for Windows fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { measureWorktreeBytes } from "./storageCleanupSize.ts";

it.effect("measures nested files without following symlinks or counting shared hardlinks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cleanup-size-" });
    const worktree = path.join(root, "worktree");
    yield* fs.makeDirectory(path.join(worktree, "nested"), { recursive: true });
    const local = path.join(worktree, "nested", "local");
    const outside = path.join(root, "shared");
    const pointer = path.join(worktree, "linked-directory");
    yield* fs.writeFileString(local, "local bytes");
    yield* fs.writeFile(outside, new Uint8Array(64 * 1024));
    yield* fs.link(outside, path.join(worktree, "hardlink"));
    // Following this link would count outside data and loop back into the worktree.
    yield* Effect.promise(() => NodeFSP.symlink(root, pointer, "dir"));
    const expected = yield* Effect.promise(
      async () =>
        ((await NodeFSP.lstat(local)).blocks +
          (await NodeFSP.lstat(pointer)).blocks +
          (await NodeFSP.lstat(worktree)).blocks +
          (await NodeFSP.lstat(path.join(worktree, "nested"))).blocks) *
        512,
    );
    expect(yield* measureWorktreeBytes(worktree)).toBe(expected);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports unavailable size instead of zero when a folder disappears", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cleanup-size-" });
    expect(yield* measureWorktreeBytes(path.join(root, "missing"))).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("includes root and nested directory allocations even without files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cleanup-size-" });
    const nested = path.join(root, "nested");
    yield* fs.makeDirectory(nested);
    const expected = yield* Effect.promise(
      async () => ((await NodeFSP.lstat(root)).blocks + (await NodeFSP.lstat(nested)).blocks) * 512,
    );
    expect(yield* measureWorktreeBytes(root)).toBe(expected);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
