import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  GitCoreService,
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  initGitRepo,
  listGitBranches,
  pullGitBranch,
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

/** Create a disposable temp directory that cleans up automatically. */
async function makeTmpDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "git-test-"));
  return {
    path: dir,
    [Symbol.asyncDispose]: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
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

async function commitWithDate(
  cwd: string,
  fileName: string,
  fileContents: string,
  dateIsoString: string,
  message: string,
): Promise<void> {
  await writeFile(path.join(cwd, fileName), fileContents);
  await git(cwd, `add ${fileName}`);
  const commitResult = await runTerminalCommand({
    command: `GIT_AUTHOR_DATE="${dateIsoString}" GIT_COMMITTER_DATE="${dateIsoString}" git commit -m "${message}"`,
    cwd,
    timeoutMs: 10_000,
  });
  if (commitResult.code !== 0) {
    throw new Error(`git dated commit failed: ${commitResult.stderr}`);
  }
}

// ── Tests ──

describe("git integration", () => {
  describe("runTerminalCommand", () => {
    it("caps captured output when maxOutputBytes is exceeded", async () => {
      const result = await runTerminalCommand({
        command: `node -e "process.stdout.write('x'.repeat(2000))"`,
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maxOutputBytes: 128,
      });

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(128);
      expect(result.stderr).toContain("output truncated");
    });
  });

  // ── initGitRepo ──

  describe("initGitRepo", () => {
    it("creates a valid git repo", async () => {
      await using tmp = await makeTmpDir();
      await initGitRepo({ cwd: tmp.path });
      expect(existsSync(path.join(tmp.path, ".git"))).toBe(true);
    });

    it("listGitBranches reports isRepo: true after init + commit", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.isRepo).toBe(true);
      expect(result.branches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it("returns isRepo: false for non-git directory", async () => {
      await using tmp = await makeTmpDir();
      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.isRepo).toBe(false);
      expect(result.branches).toEqual([]);
    });

    it("returns the current branch with current: true", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const result = await listGitBranches({ cwd: tmp.path });
      const current = result.branches.find((b) => b.current);
      expect(current).toBeDefined();
      expect(current!.current).toBe(true);
    });

    it("keeps current branch first and sorts the remaining branches by recency", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const initialBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (branch) => branch.current,
      )!.name;

      await createGitBranch({ cwd: tmp.path, branch: "older-branch" });
      await checkoutGitBranch({ cwd: tmp.path, branch: "older-branch" });
      await commitWithDate(
        tmp.path,
        "older.txt",
        "older branch change\n",
        "Thu, 1 Jan 2037 00:00:00 +0000",
        "older branch change",
      );

      await checkoutGitBranch({ cwd: tmp.path, branch: initialBranch });
      await createGitBranch({ cwd: tmp.path, branch: "newer-branch" });
      await checkoutGitBranch({ cwd: tmp.path, branch: "newer-branch" });
      await commitWithDate(
        tmp.path,
        "newer.txt",
        "newer branch change\n",
        "Fri, 1 Jan 2038 00:00:00 +0000",
        "newer branch change",
      );

      // Switch away to show current branch is pinned, then remaining branches are recency-sorted.
      await checkoutGitBranch({ cwd: tmp.path, branch: "older-branch" });

      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.branches[0]!.name).toBe("older-branch");
      expect(result.branches[1]!.name).toBe("newer-branch");
    });

    it("keeps default branch right after current branch", async () => {
      await using tmp = await makeTmpDir();
      await using remote = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const defaultBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (branch) => branch.current,
      )!.name;

      await git(remote.path, "init --bare");
      await git(tmp.path, `remote add origin ${JSON.stringify(remote.path)}`);
      await git(tmp.path, `push -u origin ${defaultBranch}`);
      await git(tmp.path, `remote set-head origin ${defaultBranch}`);

      await createGitBranch({ cwd: tmp.path, branch: "current-branch" });
      await checkoutGitBranch({ cwd: tmp.path, branch: "current-branch" });
      await commitWithDate(
        tmp.path,
        "current.txt",
        "current change\n",
        "Thu, 1 Jan 2037 00:00:00 +0000",
        "current change",
      );

      await checkoutGitBranch({ cwd: tmp.path, branch: defaultBranch });
      await createGitBranch({ cwd: tmp.path, branch: "newer-branch" });
      await checkoutGitBranch({ cwd: tmp.path, branch: "newer-branch" });
      await commitWithDate(
        tmp.path,
        "newer.txt",
        "newer change\n",
        "Fri, 1 Jan 2038 00:00:00 +0000",
        "newer change",
      );

      await checkoutGitBranch({ cwd: tmp.path, branch: "current-branch" });

      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.branches[0]!.name).toBe("current-branch");
      expect(result.branches[1]!.name).toBe(defaultBranch);
      expect(result.branches[2]!.name).toBe("newer-branch");
    });

    it("lists multiple branches after creating them", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "feature-a" });
      await createGitBranch({ cwd: tmp.path, branch: "feature-b" });

      const result = await listGitBranches({ cwd: tmp.path });
      const names = result.branches.map((b) => b.name);
      expect(names).toContain("feature-a");
      expect(names).toContain("feature-b");
    });

    it("isDefault is false when no remote exists", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.branches.every((b) => b.isDefault === false)).toBe(true);
    });
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it("checks out an existing branch", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "feature" });

      await checkoutGitBranch({ cwd: tmp.path, branch: "feature" });

      const result = await listGitBranches({ cwd: tmp.path });
      const current = result.branches.find((b) => b.current);
      expect(current!.name).toBe("feature");
    });

    it("refreshes upstream behind count after checkout when remote branch advanced", async () => {
      await using remote = await makeTmpDir();
      await using source = await makeTmpDir();
      await using clone = await makeTmpDir();
      await git(remote.path, "init --bare");

      await initRepoWithCommit(source.path);
      const defaultBranch = (await listGitBranches({ cwd: source.path })).branches.find(
        (branch) => branch.current,
      )!.name;
      await git(source.path, `remote add origin ${JSON.stringify(remote.path)}`);
      await git(source.path, `push -u origin ${defaultBranch}`);

      const featureBranch = "feature-behind";
      await createGitBranch({ cwd: source.path, branch: featureBranch });
      await checkoutGitBranch({ cwd: source.path, branch: featureBranch });
      await writeFile(path.join(source.path, "feature.txt"), "feature base\n");
      await git(source.path, "add feature.txt");
      await git(source.path, "commit -m 'feature base'");
      await git(source.path, `push -u origin ${featureBranch}`);
      await checkoutGitBranch({ cwd: source.path, branch: defaultBranch });

      await git(clone.path, `clone ${JSON.stringify(remote.path)} .`);
      await git(clone.path, "config user.email 'test@test.com'");
      await git(clone.path, "config user.name 'Test'");
      await git(clone.path, `checkout -b ${featureBranch} --track origin/${featureBranch}`);
      await writeFile(path.join(clone.path, "feature.txt"), "feature from remote\n");
      await git(clone.path, "add feature.txt");
      await git(clone.path, "commit -m 'remote feature update'");
      await git(clone.path, `push origin ${featureBranch}`);

      await checkoutGitBranch({ cwd: source.path, branch: featureBranch });
      const core = new GitCoreService();
      const details = await core.statusDetails(source.path);

      expect(details.branch).toBe(featureBranch);
      expect(details.aheadCount).toBe(0);
      expect(details.behindCount).toBe(1);
    });

    it("keeps checkout successful when upstream refresh fails", async () => {
      await using remote = await makeTmpDir();
      await using source = await makeTmpDir();
      await git(remote.path, "init --bare");

      await initRepoWithCommit(source.path);
      const defaultBranch = (await listGitBranches({ cwd: source.path })).branches.find(
        (branch) => branch.current,
      )!.name;
      await git(source.path, `remote add origin ${JSON.stringify(remote.path)}`);
      await git(source.path, `push -u origin ${defaultBranch}`);

      const featureBranch = "feature-refresh-failure";
      await git(source.path, `branch ${featureBranch}`);
      await git(source.path, `checkout ${featureBranch}`);
      await writeFile(path.join(source.path, "feature.txt"), "feature base\n");
      await git(source.path, "add feature.txt");
      await git(source.path, "commit -m 'feature base'");
      await git(source.path, `push -u origin ${featureBranch}`);
      await git(source.path, `checkout ${defaultBranch}`);

      class RefreshFailingGitCoreService extends GitCoreService {
        refreshFetchAttempts = 0;

        override async git(
          cwd: string,
          args: readonly string[],
          allowNonZeroExit = false,
        ): Promise<void> {
          if (args[0] === "fetch") {
            this.refreshFetchAttempts += 1;
            throw new Error("simulated fetch timeout");
          }
          await super.git(cwd, args, allowNonZeroExit);
        }
      }

      const core = new RefreshFailingGitCoreService();
      await expect(core.checkoutBranch({ cwd: source.path, branch: featureBranch })).resolves.toBe(
        undefined,
      );
      expect(core.refreshFetchAttempts).toBe(1);
      expect(await git(source.path, "branch --show-current")).toBe(featureBranch);
    });

    it("throws when branch does not exist", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await expect(checkoutGitBranch({ cwd: tmp.path, branch: "nonexistent" })).rejects.toThrow();
    });

    it("throws when checkout would overwrite uncommitted changes", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "other" });

      // Create a conflicting change: modify README on current branch
      await writeFile(path.join(tmp.path, "README.md"), "modified\n");
      await git(tmp.path, "add README.md");

      // First, checkout other branch cleanly
      await git(tmp.path, "stash");
      await checkoutGitBranch({ cwd: tmp.path, branch: "other" });
      await writeFile(path.join(tmp.path, "README.md"), "other content\n");
      await git(tmp.path, "add .");
      await git(tmp.path, "commit -m 'other change'");

      // Go back to default branch
      const defaultBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => !b.current,
      )!.name;
      await checkoutGitBranch({ cwd: tmp.path, branch: defaultBranch });

      // Make uncommitted changes to the same file
      await writeFile(path.join(tmp.path, "README.md"), "conflicting local\n");

      // Checkout should fail due to uncommitted changes
      await expect(checkoutGitBranch({ cwd: tmp.path, branch: "other" })).rejects.toThrow();
    });
  });

  // ── createGitBranch ──

  describe("createGitBranch", () => {
    it("creates a new branch visible in listGitBranches", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "new-feature" });

      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
    });

    it("throws when branch already exists", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "dupe" });
      await expect(createGitBranch({ cwd: tmp.path, branch: "dupe" })).rejects.toThrow();
    });
  });

  // ── createGitWorktree + removeGitWorktree ──

  describe("createGitWorktree", () => {
    it("creates a worktree with a new branch from the base branch", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);

      const wtPath = path.join(tmp.path, "worktree-out");
      const currentBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => b.current,
      )!.name;

      const result = await createGitWorktree({
        cwd: tmp.path,
        branch: currentBranch,
        newBranch: "wt-branch",
        path: wtPath,
      });

      expect(result.worktree.path).toBe(wtPath);
      expect(result.worktree.branch).toBe("wt-branch");
      expect(existsSync(wtPath)).toBe(true);
      expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

      // Clean up worktree before tmp dir disposal
      await removeGitWorktree({ cwd: tmp.path, path: wtPath });
    });

    it("worktree has the new branch checked out", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);

      const wtPath = path.join(tmp.path, "wt-check-dir");
      const currentBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => b.current,
      )!.name;

      await createGitWorktree({
        cwd: tmp.path,
        branch: currentBranch,
        newBranch: "wt-check",
        path: wtPath,
      });

      // Verify the worktree is on the new branch
      const branchOutput = await git(wtPath, "branch --show-current");
      expect(branchOutput).toBe("wt-check");

      await removeGitWorktree({ cwd: tmp.path, path: wtPath });
    });

    it("throws when new branch name already exists", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "existing" });

      const wtPath = path.join(tmp.path, "wt-conflict");
      const currentBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => b.current,
      )!.name;

      await expect(
        createGitWorktree({
          cwd: tmp.path,
          branch: currentBranch,
          newBranch: "existing",
          path: wtPath,
        }),
      ).rejects.toThrow();
    });

    it("listGitBranches from worktree cwd reports worktree branch as current", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);

      const wtPath = path.join(tmp.path, "wt-list-dir");
      const mainBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => b.current,
      )!.name;

      await createGitWorktree({
        cwd: tmp.path,
        branch: mainBranch,
        newBranch: "wt-list",
        path: wtPath,
      });

      // listGitBranches from the worktree should show wt-list as current
      const wtBranches = await listGitBranches({ cwd: wtPath });
      expect(wtBranches.isRepo).toBe(true);
      const wtCurrent = wtBranches.branches.find((b) => b.current);
      expect(wtCurrent!.name).toBe("wt-list");

      // Main repo should still show the original branch as current
      const mainBranches = await listGitBranches({ cwd: tmp.path });
      const mainCurrent = mainBranches.branches.find((b) => b.current);
      expect(mainCurrent!.name).toBe(mainBranch);

      await removeGitWorktree({ cwd: tmp.path, path: wtPath });
    });

    it("removeGitWorktree cleans up the worktree", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);

      const wtPath = path.join(tmp.path, "wt-remove-dir");
      const currentBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => b.current,
      )!.name;

      await createGitWorktree({
        cwd: tmp.path,
        branch: currentBranch,
        newBranch: "wt-remove",
        path: wtPath,
      });
      expect(existsSync(wtPath)).toBe(true);

      await removeGitWorktree({ cwd: tmp.path, path: wtPath });
      expect(existsSync(wtPath)).toBe(false);
    });
  });

  // ── Full flow: local branch checkout ──

  describe("full flow: local branch checkout", () => {
    it("init → commit → create branch → checkout → verify current", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "feature-login" });
      await checkoutGitBranch({ cwd: tmp.path, branch: "feature-login" });

      const result = await listGitBranches({ cwd: tmp.path });
      const current = result.branches.find((b) => b.current);
      expect(current!.name).toBe("feature-login");
    });
  });

  // ── Full flow: worktree creation from base branch ──

  describe("full flow: worktree creation", () => {
    it("creates worktree with new branch from current branch", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);

      const currentBranch = (await listGitBranches({ cwd: tmp.path })).branches.find(
        (b) => b.current,
      )!.name;

      const wtPath = path.join(tmp.path, "my-worktree");
      const result = await createGitWorktree({
        cwd: tmp.path,
        branch: currentBranch,
        newBranch: "feature-wt",
        path: wtPath,
      });

      // Worktree exists
      expect(existsSync(result.worktree.path)).toBe(true);

      // Main repo still on original branch
      const mainBranches = await listGitBranches({ cwd: tmp.path });
      const mainCurrent = mainBranches.branches.find((b) => b.current);
      expect(mainCurrent!.name).toBe(currentBranch);

      // Worktree is on the new branch
      const wtBranch = await git(wtPath, "branch --show-current");
      expect(wtBranch).toBe("feature-wt");

      await removeGitWorktree({ cwd: tmp.path, path: wtPath });
    });
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it("checkout a → checkout b → checkout a → current matches", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "branch-a" });
      await createGitBranch({ cwd: tmp.path, branch: "branch-b" });

      // Simulate switching to thread A's branch
      await checkoutGitBranch({ cwd: tmp.path, branch: "branch-a" });
      let branches = await listGitBranches({ cwd: tmp.path });
      expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

      // Simulate switching to thread B's branch
      await checkoutGitBranch({ cwd: tmp.path, branch: "branch-b" });
      branches = await listGitBranches({ cwd: tmp.path });
      expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

      // Switch back to thread A
      await checkoutGitBranch({ cwd: tmp.path, branch: "branch-a" });
      branches = await listGitBranches({ cwd: tmp.path });
      expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
    });
  });

  // ── Full flow: checkout conflict ──

  describe("full flow: checkout conflict", () => {
    it("uncommitted changes prevent checkout to a diverged branch", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await createGitBranch({ cwd: tmp.path, branch: "diverged" });

      // Make diverged branch have different file content
      await checkoutGitBranch({ cwd: tmp.path, branch: "diverged" });
      await writeFile(path.join(tmp.path, "README.md"), "diverged content\n");
      await git(tmp.path, "add .");
      await git(tmp.path, "commit -m 'diverge'");

      // Actually, let's just get back to the initial branch explicitly
      const allBranches = await listGitBranches({ cwd: tmp.path });
      const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
      await checkoutGitBranch({ cwd: tmp.path, branch: initialBranch });

      // Make local uncommitted changes to the same file
      await writeFile(path.join(tmp.path, "README.md"), "local uncommitted\n");

      // Attempt checkout should fail
      await expect(checkoutGitBranch({ cwd: tmp.path, branch: "diverged" })).rejects.toThrow();

      // Current branch should still be the initial one
      const result = await listGitBranches({ cwd: tmp.path });
      expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
    });
  });

  describe("GitCoreService", () => {
    it("supports branch lifecycle operations through the service API", async () => {
      await using tmp = await makeTmpDir();
      const core = new GitCoreService();

      await core.initRepo({ cwd: tmp.path });
      await git(tmp.path, "config user.email 'test@test.com'");
      await git(tmp.path, "config user.name 'Test'");
      await writeFile(path.join(tmp.path, "README.md"), "# test\n");
      await git(tmp.path, "add .");
      await git(tmp.path, "commit -m 'initial commit'");

      await core.createBranch({ cwd: tmp.path, branch: "feature/service-api" });
      await core.checkoutBranch({ cwd: tmp.path, branch: "feature/service-api" });
      const branches = await core.listBranches({ cwd: tmp.path });

      expect(branches.isRepo).toBe(true);
      expect(branches.branches.find((branch) => branch.current)?.name).toBe("feature/service-api");
    });

    it("reports status details and dirty state", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const core = new GitCoreService();

      const clean = await core.status({ cwd: tmp.path });
      expect(clean.hasWorkingTreeChanges).toBe(false);
      expect(clean.branch).toBeTruthy();

      await writeFile(path.join(tmp.path, "README.md"), "updated\n");
      const dirty = await core.statusDetails(tmp.path);
      expect(dirty.hasWorkingTreeChanges).toBe(true);
    });

    it("prepares commit context by auto-staging and creates commit", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const core = new GitCoreService();

      await writeFile(path.join(tmp.path, "README.md"), "new content\n");
      const context = await core.prepareCommitContext(tmp.path);
      expect(context).not.toBeNull();
      expect(context!.stagedSummary.length).toBeGreaterThan(0);
      expect(context!.stagedPatch.length).toBeGreaterThan(0);

      const created = await core.commit(tmp.path, "Add README update", "- include updated content");
      expect(created.commitSha.length).toBeGreaterThan(0);
      expect(await git(tmp.path, "log -1 --pretty=%s")).toBe("Add README update");
    });

    it("pushes with upstream setup and then skips when up to date", async () => {
      await using tmp = await makeTmpDir();
      await using remote = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await git(remote.path, "init --bare");
      await git(tmp.path, `remote add origin ${JSON.stringify(remote.path)}`);
      await createGitBranch({ cwd: tmp.path, branch: "feature/core-push" });
      await checkoutGitBranch({ cwd: tmp.path, branch: "feature/core-push" });

      await writeFile(path.join(tmp.path, "feature.txt"), "push me\n");
      const core = new GitCoreService();
      const context = await core.prepareCommitContext(tmp.path);
      expect(context).not.toBeNull();
      await core.commit(tmp.path, "Add feature file", "");

      const pushed = await core.pushCurrentBranch(tmp.path, null);
      expect(pushed.status).toBe("pushed");
      expect(pushed.setUpstream).toBe(true);
      expect(await git(tmp.path, "rev-parse --abbrev-ref @{upstream}")).toBe(
        "origin/feature/core-push",
      );

      const skipped = await core.pushCurrentBranch(tmp.path, null);
      expect(skipped.status).toBe("skipped_up_to_date");
    });

    it("pulls behind branch and then reports up-to-date", async () => {
      await using remote = await makeTmpDir();
      await using source = await makeTmpDir();
      await using clone = await makeTmpDir();
      await git(remote.path, "init --bare");

      await initRepoWithCommit(source.path);
      const initialBranch = (await listGitBranches({ cwd: source.path })).branches.find(
        (branch) => branch.current,
      )!.name;
      await git(source.path, `remote add origin ${JSON.stringify(remote.path)}`);
      await git(source.path, `push -u origin ${initialBranch}`);

      await git(clone.path, `clone ${JSON.stringify(remote.path)} .`);
      await git(clone.path, "config user.email 'test@test.com'");
      await git(clone.path, "config user.name 'Test'");
      await writeFile(path.join(clone.path, "CHANGELOG.md"), "remote change\n");
      await git(clone.path, "add CHANGELOG.md");
      await git(clone.path, "commit -m 'remote update'");
      await git(clone.path, `push origin ${initialBranch}`);

      const core = new GitCoreService();
      const pulled = await core.pullCurrentBranch(source.path);
      expect(pulled.status).toBe("pulled");
      expect((await core.statusDetails(source.path)).behindCount).toBe(0);

      const skipped = await core.pullCurrentBranch(source.path);
      expect(skipped.status).toBe("skipped_up_to_date");
    });

    it("top-level pullGitBranch rejects when no upstream exists", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      await expect(pullGitBranch({ cwd: tmp.path })).rejects.toThrow("no upstream");
    });

    it("lists branches when recency lookup fails", async () => {
      await using tmp = await makeTmpDir();
      await initRepoWithCommit(tmp.path);
      const core = new GitCoreService();
      const recencySpy = vi
        .spyOn(core as any, "readBranchRecency")
        .mockRejectedValueOnce(new Error("timeout"));

      const result = await core.listBranches({ cwd: tmp.path });

      expect(result.isRepo).toBe(true);
      expect(result.branches.length).toBeGreaterThan(0);
      expect(result.branches[0]?.current).toBe(true);
      recencySpy.mockRestore();
    });
  });
});
