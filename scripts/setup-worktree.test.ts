// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  linkOrCopyEnvFile,
  linkProjectEnvFiles,
  resolveWorktreePaths,
} from "./setup-worktree.ts";

const makeTempDir = (prefix: string): string =>
  NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));

describe("setup-worktree", () => {
  it("resolves worktree from env, falling back to cwd", () => {
    expect(
      resolveWorktreePaths({
        T3CODE_PROJECT_ROOT: "C:\\repo",
        T3CODE_WORKTREE_PATH: "C:\\repo-wt",
      }),
    ).toEqual({
      projectRoot: "C:\\repo",
      worktree: "C:\\repo-wt",
    });

    const resolved = resolveWorktreePaths({ T3CODE_PROJECT_ROOT: "/repo" });
    expect(resolved.projectRoot).toBe("/repo");
    expect(resolved.worktree).toBe(process.cwd());
  });

  it("links or copies env files into the worktree", () => {
    const root = makeTempDir("setup-worktree-root-");
    const worktree = makeTempDir("setup-worktree-wt-");
    try {
      NodeFs.mkdirSync(NodePath.join(root, "infra", "relay"), { recursive: true });
      NodeFs.writeFileSync(NodePath.join(root, ".env"), "ROOT=1\n", "utf8");
      NodeFs.writeFileSync(NodePath.join(root, "infra", "relay", ".env"), "RELAY=1\n", "utf8");

      const results = linkProjectEnvFiles({ projectRoot: root, worktree });
      expect(results).toHaveLength(2);
      for (const entry of results) {
        expect(["linked", "copied"]).toContain(entry.result);
      }
      // Either linked or copied is fine; content must match.
      expect(NodeFs.readFileSync(NodePath.join(worktree, ".env"), "utf8")).toBe("ROOT=1\n");
      expect(NodeFs.readFileSync(NodePath.join(worktree, "infra", "relay", ".env"), "utf8")).toBe(
        "RELAY=1\n",
      );
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true });
      NodeFs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("does not delete a worktree env file when the source is missing", () => {
    const root = makeTempDir("setup-worktree-missing-root-");
    const worktree = makeTempDir("setup-worktree-missing-wt-");
    try {
      const destination = NodePath.join(worktree, ".env");
      NodeFs.writeFileSync(destination, "LOCAL=1\n", "utf8");

      expect(
        linkOrCopyEnvFile({
          projectRoot: root,
          worktree,
          relativePath: ".env",
        }),
      ).toBe("skipped-missing-source");
      expect(NodeFs.readFileSync(destination, "utf8")).toBe("LOCAL=1\n");
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true });
      NodeFs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("skips when project root and worktree are the same path", () => {
    const root = makeTempDir("setup-worktree-same-");
    try {
      NodeFs.writeFileSync(NodePath.join(root, ".env"), "SAME=1\n", "utf8");
      expect(
        linkOrCopyEnvFile({
          projectRoot: root,
          worktree: root,
          relativePath: ".env",
        }),
      ).toBe("skipped-same-path");
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips when worktree is a symlink/junction to the project root", () => {
    const root = makeTempDir("setup-worktree-alias-root-");
    const parent = makeTempDir("setup-worktree-alias-parent-");
    const alias = NodePath.join(parent, "wt-alias");
    try {
      NodeFs.writeFileSync(NodePath.join(root, ".env"), "ROOT=1\n", "utf8");
      try {
        NodeFs.symlinkSync(root, alias, "junction");
      } catch {
        // Junction/symlink may be denied; skip this platform-specific case.
        return;
      }
      expect(
        linkOrCopyEnvFile({
          projectRoot: root,
          worktree: alias,
          relativePath: ".env",
        }),
      ).toBe("skipped-same-path");
      // Must not have replaced root/.env with a self-link/copy mess.
      expect(NodeFs.readFileSync(NodePath.join(root, ".env"), "utf8")).toBe("ROOT=1\n");
    } finally {
      NodeFs.rmSync(alias, { force: true });
      NodeFs.rmSync(root, { recursive: true, force: true });
      NodeFs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("skips non-file sources without touching the worktree env", () => {
    const root = makeTempDir("setup-worktree-dir-root-");
    const worktree = makeTempDir("setup-worktree-dir-wt-");
    try {
      NodeFs.mkdirSync(NodePath.join(root, ".env"));
      const destination = NodePath.join(worktree, ".env");
      NodeFs.writeFileSync(destination, "LOCAL=1\n", "utf8");

      expect(
        linkOrCopyEnvFile({
          projectRoot: root,
          worktree,
          relativePath: ".env",
        }),
      ).toBe("skipped-not-a-file");
      expect(NodeFs.readFileSync(destination, "utf8")).toBe("LOCAL=1\n");
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true });
      NodeFs.rmSync(worktree, { recursive: true, force: true });
    }
  });

});
