import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type * as Path from "effect/Path";

import { listManagedWorktreesRoots, resolveWorktreesDirectory } from "./worktreesDirectory.ts";

const path = {
  resolve: (...segments: string[]) => NodePath.resolve(...segments),
  join: (...segments: string[]) => NodePath.join(...segments),
} as Path.Path;

const defaultWorktreesDir = NodePath.join(NodeOS.tmpdir(), "t3-default-worktrees");

describe("resolveWorktreesDirectory", () => {
  it("uses the environment default when the setting is empty", () => {
    expect(resolveWorktreesDirectory("", defaultWorktreesDir, path)).toBe(
      NodePath.resolve(defaultWorktreesDir),
    );
    expect(resolveWorktreesDirectory("   ", defaultWorktreesDir, path)).toBe(
      NodePath.resolve(defaultWorktreesDir),
    );
  });

  it("resolves an absolute configured directory", () => {
    const configured = NodePath.join(NodeOS.tmpdir(), "t3-custom-worktrees");
    expect(resolveWorktreesDirectory(configured, defaultWorktreesDir, path)).toBe(
      NodePath.resolve(configured),
    );
  });

  it("expands a leading tilde", () => {
    expect(resolveWorktreesDirectory("~/t3-worktrees", defaultWorktreesDir, path)).toBe(
      NodePath.resolve(NodePath.join(NodeOS.homedir(), "t3-worktrees")),
    );
  });
});

describe("listManagedWorktreesRoots", () => {
  it("returns only the default when nothing is configured", () => {
    expect(listManagedWorktreesRoots("", defaultWorktreesDir, path)).toEqual([
      NodePath.resolve(defaultWorktreesDir),
    ]);
  });

  it("keeps the default alongside a distinct configured directory", () => {
    const configured = NodePath.join(NodeOS.tmpdir(), "t3-custom-worktrees");
    expect(listManagedWorktreesRoots(configured, defaultWorktreesDir, path)).toEqual([
      NodePath.resolve(configured),
      NodePath.resolve(defaultWorktreesDir),
    ]);
  });

  it("does not duplicate the default when the setting names it", () => {
    expect(listManagedWorktreesRoots(defaultWorktreesDir, defaultWorktreesDir, path)).toEqual([
      NodePath.resolve(defaultWorktreesDir),
    ]);
  });
});
