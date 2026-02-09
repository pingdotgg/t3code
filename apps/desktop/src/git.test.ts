import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  initGitRepo,
  listGitBranches,
  removeGitWorktree,
  runTerminalCommand,
} from "./git";

// ── Helpers ──

/** Run a raw git command for test setup (not under test). */
async function git(cwd: string, command: string): Promise<string> {
  const result = await runTerminalCommand({
    command: `git ${command}`,
    cwd,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${command} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Create a repo with an initial commit so branches work. */
async function initRepoWithCommit(cwd: string): Promise<void> {
  await initGitRepo({ cwd });
  await git(cwd, "config user.email 'test@test.com'");
  await git(cwd, "config user.name 'Test'");
  await writeFile(path.join(cwd, "README.md"), "# test\n");
  await git(cwd, "add .");
  await git(cwd, "commit -m 'initial commit'");
}

// ── Tests ──

describe("git integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "git-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── initGitRepo ──

  describe("initGitRepo", () => {
    it("creates a valid git repo", async () => {
      await initGitRepo({ cwd: tmpDir });
      expect(existsSync(path.join(tmpDir, ".git"))).toBe(true);
    });

    it("listGitBranches reports isRepo: true after init + commit", async () => {
      await initRepoWithCommit(tmpDir);
      const result = await listGitBranches({ cwd: tmpDir });
      expect(result.isRepo).toBe(true);
      expect(result.branches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it("returns isRepo: false for non-git directory", async () => {
      const result = await listGitBranches({ cwd: tmpDir });
      expect(result.isRepo).toBe(false);
      expect(result.branches).toEqual([]);
    });

    it("returns the current branch with current: true", async () => {
      await initRepoWithCommit(tmpDir);
      const result = await listGitBranches({ cwd: tmpDir });
      const current = result.branches.find((b) => b.current);
      expect(current).toBeDefined();
      expect(current!.current).toBe(true);
    });

    it("sorts current branch first", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "aaa-first-alpha" });
      await createGitBranch({ cwd: tmpDir, branch: "zzz-last" });

      const result = await listGitBranches({ cwd: tmpDir });
      expect(result.branches[0]!.current).toBe(true);
    });

    it("lists multiple branches after creating them", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "feature-a" });
      await createGitBranch({ cwd: tmpDir, branch: "feature-b" });

      const result = await listGitBranches({ cwd: tmpDir });
      const names = result.branches.map((b) => b.name);
      expect(names).toContain("feature-a");
      expect(names).toContain("feature-b");
    });

    it("isDefault is false when no remote exists", async () => {
      await initRepoWithCommit(tmpDir);
      const result = await listGitBranches({ cwd: tmpDir });
      expect(result.branches.every((b) => b.isDefault === false)).toBe(true);
    });
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it("checks out an existing branch", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "feature" });

      await checkoutGitBranch({ cwd: tmpDir, branch: "feature" });

      const result = await listGitBranches({ cwd: tmpDir });
      const current = result.branches.find((b) => b.current);
      expect(current!.name).toBe("feature");
    });

    it("throws when branch does not exist", async () => {
      await initRepoWithCommit(tmpDir);
      await expect(
        checkoutGitBranch({ cwd: tmpDir, branch: "nonexistent" }),
      ).rejects.toThrow();
    });

    it("throws when checkout would overwrite uncommitted changes", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "other" });

      // Create a conflicting change: modify README on current branch
      await writeFile(path.join(tmpDir, "README.md"), "modified\n");
      await git(tmpDir, "add README.md");

      // On the other branch, README has original content — checkout should conflict
      // Actually git checkout with staged changes can sometimes work, so let's
      // create a real conflict: commit different content on other branch first.
      // Simpler: write to a tracked file without committing, then checkout a branch
      // where that file differs.

      // First, checkout other branch cleanly
      await git(tmpDir, "stash");
      await checkoutGitBranch({ cwd: tmpDir, branch: "other" });
      await writeFile(path.join(tmpDir, "README.md"), "other content\n");
      await git(tmpDir, "add .");
      await git(tmpDir, "commit -m 'other change'");

      // Go back to default branch
      const defaultBranch = (
        await listGitBranches({ cwd: tmpDir })
      ).branches.find((b) => !b.current)!.name;
      await checkoutGitBranch({ cwd: tmpDir, branch: defaultBranch });

      // Make uncommitted changes to the same file
      await writeFile(path.join(tmpDir, "README.md"), "conflicting local\n");

      // Checkout should fail due to uncommitted changes
      await expect(
        checkoutGitBranch({ cwd: tmpDir, branch: "other" }),
      ).rejects.toThrow();
    });
  });

  // ── createGitBranch ──

  describe("createGitBranch", () => {
    it("creates a new branch visible in listGitBranches", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "new-feature" });

      const result = await listGitBranches({ cwd: tmpDir });
      expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
    });

    it("throws when branch already exists", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "dupe" });
      await expect(
        createGitBranch({ cwd: tmpDir, branch: "dupe" }),
      ).rejects.toThrow();
    });
  });

  // ── createGitWorktree + removeGitWorktree ──

  describe("createGitWorktree", () => {
    it("creates a worktree directory at the expected path", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "wt-branch" });

      const wtPath = path.join(tmpDir, "worktree-out");
      const result = await createGitWorktree({
        cwd: tmpDir,
        branch: "wt-branch",
        path: wtPath,
      });

      expect(result.worktree.path).toBe(wtPath);
      expect(result.worktree.branch).toBe("wt-branch");
      expect(existsSync(wtPath)).toBe(true);
      expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

      // Clean up worktree
      await removeGitWorktree({ cwd: tmpDir, path: wtPath });
    });

    it("worktree has the correct branch checked out", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "wt-check" });

      const wtPath = path.join(tmpDir, "wt-check-dir");
      await createGitWorktree({
        cwd: tmpDir,
        branch: "wt-check",
        path: wtPath,
      });

      // Verify the worktree is on the right branch
      const branchOutput = await git(wtPath, "branch --show-current");
      expect(branchOutput).toBe("wt-check");

      await removeGitWorktree({ cwd: tmpDir, path: wtPath });
    });

    it("throws when branch is already checked out in main worktree", async () => {
      await initRepoWithCommit(tmpDir);
      // Try to create a worktree for the current branch (already checked out)
      const branches = await listGitBranches({ cwd: tmpDir });
      const currentBranch = branches.branches.find((b) => b.current)!.name;

      const wtPath = path.join(tmpDir, "wt-conflict");
      await expect(
        createGitWorktree({
          cwd: tmpDir,
          branch: currentBranch,
          path: wtPath,
        }),
      ).rejects.toThrow();
    });

    it("removeGitWorktree cleans up the worktree", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "wt-remove" });

      const wtPath = path.join(tmpDir, "wt-remove-dir");
      await createGitWorktree({
        cwd: tmpDir,
        branch: "wt-remove",
        path: wtPath,
      });
      expect(existsSync(wtPath)).toBe(true);

      await removeGitWorktree({ cwd: tmpDir, path: wtPath });
      expect(existsSync(wtPath)).toBe(false);
    });
  });

  // ── Full flow: local branch checkout ──

  describe("full flow: local branch checkout", () => {
    it("init → commit → create branch → checkout → verify current", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "feature-login" });
      await checkoutGitBranch({ cwd: tmpDir, branch: "feature-login" });

      const result = await listGitBranches({ cwd: tmpDir });
      const current = result.branches.find((b) => b.current);
      expect(current!.name).toBe("feature-login");
    });
  });

  // ── Full flow: worktree creation from selected branch ──

  describe("full flow: worktree creation", () => {
    it("creates worktree from a non-current branch", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "feature-wt" });

      const wtPath = path.join(tmpDir, "my-worktree");
      const result = await createGitWorktree({
        cwd: tmpDir,
        branch: "feature-wt",
        path: wtPath,
      });

      // Worktree exists
      expect(existsSync(result.worktree.path)).toBe(true);

      // Main repo still on original branch
      const mainBranches = await listGitBranches({ cwd: tmpDir });
      const mainCurrent = mainBranches.branches.find((b) => b.current);
      expect(mainCurrent!.name).not.toBe("feature-wt");

      // Worktree is on feature-wt
      const wtBranch = await git(wtPath, "branch --show-current");
      expect(wtBranch).toBe("feature-wt");

      await removeGitWorktree({ cwd: tmpDir, path: wtPath });
    });
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it("checkout a → checkout b → checkout a → current matches", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "branch-a" });
      await createGitBranch({ cwd: tmpDir, branch: "branch-b" });

      // Simulate switching to thread A's branch
      await checkoutGitBranch({ cwd: tmpDir, branch: "branch-a" });
      let branches = await listGitBranches({ cwd: tmpDir });
      expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

      // Simulate switching to thread B's branch
      await checkoutGitBranch({ cwd: tmpDir, branch: "branch-b" });
      branches = await listGitBranches({ cwd: tmpDir });
      expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

      // Switch back to thread A
      await checkoutGitBranch({ cwd: tmpDir, branch: "branch-a" });
      branches = await listGitBranches({ cwd: tmpDir });
      expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
    });
  });

  // ── Full flow: checkout conflict ──

  describe("full flow: checkout conflict", () => {
    it("uncommitted changes prevent checkout to a diverged branch", async () => {
      await initRepoWithCommit(tmpDir);
      await createGitBranch({ cwd: tmpDir, branch: "diverged" });

      // Make diverged branch have different file content
      await checkoutGitBranch({ cwd: tmpDir, branch: "diverged" });
      await writeFile(path.join(tmpDir, "README.md"), "diverged content\n");
      await git(tmpDir, "add .");
      await git(tmpDir, "commit -m 'diverge'");

      // Go back to default branch
      const defaultBranch = (
        await git(tmpDir, "rev-parse --abbrev-ref HEAD")
      ).includes("diverged")
        ? // we're on diverged, need to find the other one
          (await listGitBranches({ cwd: tmpDir })).branches.find(
            (b) => !b.current && b.name !== "diverged",
          )!.name
        : (await git(tmpDir, "rev-parse --abbrev-ref HEAD"));

      // Actually, let's just get back to the initial branch explicitly
      const allBranches = await listGitBranches({ cwd: tmpDir });
      const initialBranch = allBranches.branches.find(
        (b) => b.name !== "diverged",
      )!.name;
      await checkoutGitBranch({ cwd: tmpDir, branch: initialBranch });

      // Make local uncommitted changes to the same file
      await writeFile(path.join(tmpDir, "README.md"), "local uncommitted\n");

      // Attempt checkout should fail
      await expect(
        checkoutGitBranch({ cwd: tmpDir, branch: "diverged" }),
      ).rejects.toThrow();

      // Current branch should still be the initial one
      const result = await listGitBranches({ cwd: tmpDir });
      expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
    });
  });
});
