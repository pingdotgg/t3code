import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalizeWorktreePath, resolveGitWorktreeIdentity } from "./worktreePaths.ts";

async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile("git", [...args], { cwd }, (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

describe("worktreePaths", () => {
  const created: Array<string> = [];

  const makeRepo = async (): Promise<{ readonly root: string; readonly worktree: string }> => {
    const base = await mkdtemp(path.join(tmpdir(), "worktree-paths-"));
    created.push(base);
    const root = path.join(base, "repo");
    await mkdir(root);
    await runGit(root, ["init", "--initial-branch=main"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await writeFile(path.join(root, "file"), "contents\n");
    await runGit(root, ["add", "."]);
    await runGit(root, ["commit", "-m", "initial"]);
    const worktree = path.join(base, "linked");
    await runGit(root, ["worktree", "add", worktree, "-b", "feature"]);
    return { root, worktree };
  };

  afterEach(async () => {
    while (created.length > 0) {
      await rm(created.pop()!, { recursive: true, force: true });
    }
  });

  it("resolves the same identity for equivalent path spellings", async () => {
    const { root } = await makeRepo();
    const direct = await resolveGitWorktreeIdentity(root);
    const indirect = await resolveGitWorktreeIdentity(path.join(root, ".", ""));

    expect(direct.canonicalPath).toBe(indirect.canonicalPath);
    expect(direct.gitRoot).toBe(direct.canonicalPath);
    expect(indirect.gitRoot).toBe(direct.canonicalPath);
  });

  it("resolves each linked worktree to its own top level", async () => {
    const { root, worktree } = await makeRepo();

    const main = await resolveGitWorktreeIdentity(root);
    const linked = await resolveGitWorktreeIdentity(worktree);

    expect(linked.canonicalPath).not.toBe(main.canonicalPath);
    expect(linked.gitRoot).toBe(linked.canonicalPath);
    expect(main.gitRoot).toBe(main.canonicalPath);
  });

  it("follows a symlink to the same identity as its target", async () => {
    const { root } = await makeRepo();
    const link = path.join(path.dirname(root), "link-to-repo");
    created.push(path.dirname(link));
    await symlink(root, link);

    const viaLink = await resolveGitWorktreeIdentity(link);
    const viaTarget = await resolveGitWorktreeIdentity(root);

    expect(viaLink.canonicalPath).toBe(viaTarget.canonicalPath);
    expect(viaLink.gitRoot).toBe(viaTarget.gitRoot);
  });

  it("reports no git root for a directory outside a repository", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "worktree-plain-"));
    created.push(base);
    const plain = path.join(base, "plain");
    await mkdir(plain);

    expect((await resolveGitWorktreeIdentity(plain)).gitRoot).toBeNull();
  });

  it("re-resolves identity after the directory is replaced in place", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "worktree-replace-"));
    created.push(base);
    const target = path.join(base, "swap");
    await mkdir(target);

    const first = await resolveGitWorktreeIdentity(target);
    expect(first.gitRoot).toBeNull();

    // Replace the directory with a real repository at the same path. A stale
    // memo must not report the pre-replacement identity.
    await rm(target, { recursive: true, force: true });
    await mkdir(target);
    await runGit(target, ["init", "--initial-branch=main"]);

    const second = await resolveGitWorktreeIdentity(target);
    expect(second.gitRoot).toBe(second.canonicalPath);
  });

  it("does not resolve a removed checkout", async () => {
    const { worktree } = await makeRepo();
    expect((await resolveGitWorktreeIdentity(worktree)).gitRoot).not.toBeNull();

    await rm(worktree, { recursive: true, force: true });

    expect((await resolveGitWorktreeIdentity(worktree)).gitRoot).toBeNull();
  });

  it("canonicalizes a path that does not exist without throwing", async () => {
    const missing = path.join(tmpdir(), "definitely-missing-worktree-path");
    expect(await canonicalizeWorktreePath(missing)).toBe(path.resolve(missing));
  });
});
