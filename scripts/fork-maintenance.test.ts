// Fork maintenance routine: drives the real scripts against tiny git fixtures.
// @effect-diagnostics nodeBuiltinImport:off - Drives the real bash/sh routines against throwaway git fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const scriptsDir = import.meta.dirname;
const forkCheck = NodePath.join(scriptsDir, "fork-check.sh");
const forkRebase = NodePath.join(scriptsDir, "fork-rebase.sh");

function git(cwd: string, ...args: Array<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixture(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-check-"));
  git(root, "init", "-q", "-b", "work");
  git(root, "config", "user.email", "fork-check@test");
  git(root, "config", "user.name", "fork-check");
  NodeFS.mkdirSync(NodePath.join(root, "docs"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "scripts"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "docs", "fork.md"), "# Fork maintenance\n");
  NodeFS.writeFileSync(
    NodePath.join(root, "scripts", "fork-upstream-edits.txt"),
    "# allowlist\nscripts/fork-upstream-edits.txt\n",
  );
  NodeFS.writeFileSync(NodePath.join(root, "upstream-owned.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

function runCheck(cwd: string, ...args: Array<string>): { status: number; output: string } {
  try {
    const output = NodeChildProcess.execFileSync("bash", [forkCheck, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { status: 0, output };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

function baseOf(root: string): string {
  return git(root, "rev-parse", "HEAD").trim();
}

describe("fork-check", () => {
  it("passes for fork-only new files on top of the base", () => {
    const root = makeFixture();
    const base = baseOf(root);
    NodeFS.writeFileSync(NodePath.join(root, "docs", "new-fork-doc.md"), "fork only\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fork: new file");
    const result = runCheck(root, "--base", base);
    expect(result.status).toBe(0);
    expect(result.output).toContain("fork-check: OK.");
  });

  it("fails on unallowlisted upstream edits and passes once allowlisted", () => {
    const root = makeFixture();
    const base = baseOf(root);
    NodeFS.writeFileSync(NodePath.join(root, "upstream-owned.txt"), "forked\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fork: touch upstream file");
    const denied = runCheck(root, "--base", base);
    expect(denied.status).toBe(1);
    expect(denied.output).toContain("not allowlisted: upstream-owned.txt");

    NodeFS.appendFileSync(
      NodePath.join(root, "scripts", "fork-upstream-edits.txt"),
      "upstream-owned.txt\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fork: allowlist the edit");
    const allowed = runCheck(root, "--base", base);
    expect(allowed.status).toBe(0);
    expect(allowed.output).toContain("modified (allowlisted): upstream-owned.txt");
  });

  it("fails on merge commits in the stack", () => {
    const root = makeFixture();
    const base = baseOf(root);
    git(root, "checkout", "-qb", "side");
    NodeFS.writeFileSync(NodePath.join(root, "side.txt"), "side\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "side");
    git(root, "checkout", "-q", "work");
    NodeFS.writeFileSync(NodePath.join(root, "work.txt"), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "work");
    git(root, "merge", "--no-ff", "-m", "merge side", "side");
    const result = runCheck(root, "--base", base);
    expect(result.status).toBe(1);
    expect(result.output).toContain("merge commits in the fork stack");
  });

  it("fails when docs/fork.md is missing", () => {
    const root = makeFixture();
    const base = baseOf(root);
    NodeFS.rmSync(NodePath.join(root, "docs", "fork.md"));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fork: drop the doc");
    const result = runCheck(root, "--base", base);
    expect(result.status).toBe(1);
    expect(result.output).toContain("docs/fork.md is missing");
  });
});

describe("fork-rebase safety rules", () => {
  it("refuses to push without proof in the same run", () => {
    const root = makeFixture();
    try {
      NodeChildProcess.execFileSync("bash", [forkRebase, "--push"], {
        cwd: root,
        encoding: "utf8",
      });
      expect.unreachable("fork-rebase --push without --proof must fail");
    } catch (error) {
      const result = error as { status?: number; stderr?: string };
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to push without proof");
    }
  });

  it("refuses to push main directly", () => {
    const root = makeFixture();
    git(root, "checkout", "-qb", "main");
    try {
      NodeChildProcess.execFileSync("bash", [forkRebase, "--proof", "--push"], {
        cwd: root,
        encoding: "utf8",
      });
      expect.unreachable("fork-rebase --push on main must fail");
    } catch (error) {
      const result = error as { status?: number; stderr?: string };
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to push main directly");
    }
  });
});
