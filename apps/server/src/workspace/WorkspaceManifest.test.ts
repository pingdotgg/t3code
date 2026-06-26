import { describe, expect, it } from "@effect/vitest";

import {
  buildWorkspaceManifest,
  manifestDirectories,
  manifestExtraRoots,
} from "./WorkspaceManifest.ts";

describe("buildWorkspaceManifest", () => {
  it("spans every repo root for a multi-repo project, anchored at the workspace file dir", () => {
    const manifest = buildWorkspaceManifest({
      worktreePath: null,
      workspaceRoot: "/Users/me/work",
      repoRoots: ["/Users/me/work/backend", "/Users/me/oss/frontend"],
    });

    expect(manifest.anchor).toBe("/Users/me/work");
    expect(manifest.roots).toEqual([
      { path: "/Users/me/work/backend", name: "backend" },
      { path: "/Users/me/oss/frontend", name: "frontend" },
    ]);
  });

  it("falls back to [workspaceRoot] when no repo roots are recorded", () => {
    const manifest = buildWorkspaceManifest({
      worktreePath: null,
      workspaceRoot: "/work/solo",
      repoRoots: [],
    });

    expect(manifest.anchor).toBe("/work/solo");
    expect(manifest.roots).toEqual([{ path: "/work/solo", name: "solo" }]);
  });

  it("collapses to the worktree path in isolated mode, ignoring repo roots", () => {
    const manifest = buildWorkspaceManifest({
      worktreePath: "/worktrees/p/t/backend",
      workspaceRoot: "/work",
      repoRoots: ["/work/backend", "/work/frontend"],
    });

    expect(manifest.anchor).toBe("/worktrees/p/t/backend");
    expect(manifest.roots).toEqual([{ path: "/worktrees/p/t/backend", name: "backend" }]);
  });

  it("points every root at its per-root worktree in isolated multi-repo mode", () => {
    const manifest = buildWorkspaceManifest({
      worktreePath: "/worktrees/p/t/backend",
      worktrees: [
        { repoRoot: "/work/backend", worktreePath: "/worktrees/p/t/backend" },
        { repoRoot: "/oss/frontend", worktreePath: "/worktrees/p/t/frontend" },
      ],
      workspaceRoot: "/work",
      repoRoots: ["/work/backend", "/oss/frontend"],
    });

    // Anchor falls to the first worktree (no worktree matches the workspace
    // root, which is the non-git .code-workspace dir); both copies are roots.
    expect(manifest.anchor).toBe("/worktrees/p/t/backend");
    expect(manifest.roots).toEqual([
      { path: "/worktrees/p/t/backend", name: "backend" },
      { path: "/worktrees/p/t/frontend", name: "frontend" },
    ]);
  });

  it("anchors on the worktree of the workspace root when one exists", () => {
    const manifest = buildWorkspaceManifest({
      worktreePath: "/worktrees/p/t/repo",
      worktrees: [
        { repoRoot: "/oss/lib", worktreePath: "/worktrees/p/t/lib" },
        { repoRoot: "/work/repo", worktreePath: "/worktrees/p/t/repo" },
      ],
      workspaceRoot: "/work/repo",
      repoRoots: ["/oss/lib", "/work/repo"],
    });

    expect(manifest.anchor).toBe("/worktrees/p/t/repo");
  });

  it("dedupes repeated root paths", () => {
    const manifest = buildWorkspaceManifest({
      worktreePath: null,
      workspaceRoot: "/work",
      repoRoots: ["/work/backend", "/work/backend"],
    });

    expect(manifest.roots).toEqual([{ path: "/work/backend", name: "backend" }]);
  });
});

describe("manifestDirectories", () => {
  it("includes the anchor plus every root, deduped", () => {
    const directories = manifestDirectories({
      anchor: "/work",
      roots: [
        { path: "/work/backend", name: "backend" },
        { path: "/oss/frontend", name: "frontend" },
      ],
    });

    expect(directories).toEqual(["/work", "/work/backend", "/oss/frontend"]);
  });

  it("collapses to a single directory when the anchor is the only root", () => {
    const directories = manifestDirectories({
      anchor: "/work/solo",
      roots: [{ path: "/work/solo", name: "solo" }],
    });

    expect(directories).toEqual(["/work/solo"]);
  });
});

describe("manifestExtraRoots", () => {
  it("returns the roots excluding the anchor", () => {
    const extraRoots = manifestExtraRoots({
      anchor: "/work",
      roots: [
        { path: "/work/backend", name: "backend" },
        { path: "/oss/frontend", name: "frontend" },
      ],
    });

    expect(extraRoots).toEqual(["/work/backend", "/oss/frontend"]);
  });

  it("is empty for a single-root project anchored at the repo", () => {
    const extraRoots = manifestExtraRoots({
      anchor: "/work/solo",
      roots: [{ path: "/work/solo", name: "solo" }],
    });

    expect(extraRoots).toEqual([]);
  });
});
