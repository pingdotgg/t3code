// @effect-diagnostics nodeBuiltinImport:off - These tests exercise the filesystem boundary, including symlinks and hardlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { measureWorktreeBytes } from "./storageCleanupSize.ts";

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cleanup-size-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

it.effect("measures nested files without following symlinks or counting shared hardlinks", () =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    const worktree = NodePath.join(root, "worktree");
    const expected = yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.join(worktree, "nested"), { recursive: true });
      const local = NodePath.join(worktree, "nested", "local");
      const outside = NodePath.join(root, "shared");
      const pointer = NodePath.join(worktree, "linked-directory");
      await NodeFSP.writeFile(local, "local bytes");
      await NodeFSP.writeFile(outside, Buffer.alloc(64 * 1024));
      await NodeFSP.link(outside, NodePath.join(worktree, "hardlink"));
      // Following this link would count outside data and loop back into the worktree.
      await NodeFSP.symlink(root, pointer, "dir");
      return ((await NodeFSP.lstat(local)).blocks + (await NodeFSP.lstat(pointer)).blocks) * 512;
    });
    expect(yield* measureWorktreeBytes(worktree)).toBe(expected);
  }).pipe(Effect.scoped),
);

it.effect("reports unavailable size instead of zero when a folder disappears", () =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    expect(yield* measureWorktreeBytes(NodePath.join(root, "missing"))).toBeNull();
  }).pipe(Effect.scoped),
);
