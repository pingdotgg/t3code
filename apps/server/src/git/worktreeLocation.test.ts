// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  joinWorktreePath,
  lookupWorktreeRoot,
  resolveConfiguredWorktreeRoot,
  sanitizeWorktreeBranch,
} from "./worktreeLocation.ts";

describe("sanitizeWorktreeBranch", () => {
  it("replaces every slash so the branch is a single directory name", () => {
    expect(sanitizeWorktreeBranch("feature/nested/branch")).toBe("feature-nested-branch");
  });

  it("leaves slashless branches alone", () => {
    expect(sanitizeWorktreeBranch("main")).toBe("main");
  });
});

describe("resolveConfiguredWorktreeRoot", () => {
  it("expands a leading ~", () => {
    const result = resolveConfiguredWorktreeRoot("~/dev/worktrees");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toBe(NodePath.join(NodeOS.homedir(), "dev/worktrees"));
  });

  it("expands a bare ~", () => {
    const result = resolveConfiguredWorktreeRoot("~");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toBe(NodeOS.homedir());
  });

  it("trims surrounding whitespace before validating", () => {
    const result = resolveConfiguredWorktreeRoot("  /tmp/worktrees  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root).toBe("/tmp/worktrees");
  });

  it("rejects relative paths rather than resolving them against the server cwd", () => {
    const result = resolveConfiguredWorktreeRoot("dev/worktrees");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("absolute");
  });

  it("rejects an empty value", () => {
    expect(resolveConfiguredWorktreeRoot("   ").ok).toBe(false);
  });
});

describe("lookupWorktreeRoot", () => {
  const settings = {
    worktreeDirectoryOverrides: { "/repos/alpha": "/tmp/alpha-worktrees" },
  } as const;

  it("returns null when the project has no override", () => {
    expect(lookupWorktreeRoot({ settings, workspaceRoot: "/repos/beta" })).toBeNull();
  });

  it("resolves the configured root for a matching project", () => {
    const result = lookupWorktreeRoot({ settings, workspaceRoot: "/repos/alpha" });
    expect(result?.ok).toBe(true);
  });

  it("surfaces a failure for a configured-but-invalid root instead of falling back", () => {
    const result = lookupWorktreeRoot({
      settings: { worktreeDirectoryOverrides: { "/repos/alpha": "relative/path" } },
      workspaceRoot: "/repos/alpha",
    });
    expect(result?.ok).toBe(false);
  });
});

describe("joinWorktreePath", () => {
  it("puts the branch directly inside the configured root", () => {
    expect(
      joinWorktreePath({
        root: "/tmp/worktrees",
        refName: "main",
        newRefName: "feature/login",
      }),
    ).toBe("/tmp/worktrees/feature-login");
  });

  it("does not re-nest under the repository name", () => {
    // The VSCode-style `<repo>.worktrees` layout already names the project;
    // another `<repo>` level inside it is redundant.
    expect(
      joinWorktreePath({
        root: "/projects/poleOS/poleos-frontend.worktrees",
        refName: "main",
        newRefName: "my-branch",
      }),
    ).toBe("/projects/poleOS/poleos-frontend.worktrees/my-branch");
  });

  it("falls back to refName when no new branch is being created", () => {
    expect(
      joinWorktreePath({
        root: "/tmp/worktrees",
        refName: "release/1.2",
      }),
    ).toBe("/tmp/worktrees/release-1.2");
  });
});
