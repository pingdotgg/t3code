// Fork maintenance routine: drives the real scripts against tiny git fixtures.
// @effect-diagnostics nodeBuiltinImport:off - Drives the real bash/sh routines against throwaway git fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const scriptsDir = import.meta.dirname;
const forkCheck = NodePath.join(scriptsDir, "fork-check.sh");
const forkFeatures = NodePath.join(scriptsDir, "fork-features.mjs");
const forkRebase = NodePath.join(scriptsDir, "fork-rebase.sh");

function git(cwd: string, ...args: Array<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeMap(root: string, upstreamFiles = ["scripts/fork-upstream-edits.txt"], extra = {}) {
  const feature = {
    id: "fixture",
    purpose: "Protect the fixture capability.",
    issues: ["https://github.com/toolboxmd/t3code/issues/20"],
    prs: ["https://github.com/toolboxmd/t3code/pull/9"],
    newFiles: ["new-capability.txt"],
    upstreamFiles,
    sharedFiles: ["watched.txt"],
    keywords: ["child thread", "parentThreadId"],
    ...extra,
  };
  NodeFS.writeFileSync(
    NodePath.join(root, "docs/fork-features.md"),
    "# Features\n\n```json\n" + JSON.stringify(feature) + "\n```\n",
  );
}

const fixtures: Array<string> = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function makeFixture(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-check-"));
  fixtures.push(root);
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
  writeMap(root);
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
    writeMap(root, ["scripts/fork-upstream-edits.txt", "upstream-owned.txt"]);
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

describe("fork feature ownership", () => {
  it("rejects an allowlisted path without an owner", () => {
    const root = makeFixture();
    writeMap(root, []);
    const result = runCheck(root, "--base", baseOf(root));
    expect(result.status).toBe(1);
    expect(result.output).toContain("expected exactly one feature owner, found 0");
  });

  it("rejects two owners and duplicate feature ids", () => {
    const root = makeFixture();
    const path = NodePath.join(root, "docs/fork-features.md");
    const original = NodeFS.readFileSync(path, "utf8");
    NodeFS.appendFileSync(path, original.replace('"fixture"', '"second"'));
    expect(runCheck(root, "--base", baseOf(root)).output).toContain("found 2");
    NodeFS.writeFileSync(path, original + original);
    expect(runCheck(root, "--base", baseOf(root)).output).toContain("duplicate feature id");
  });

  it("rejects missing or malformed maps and stale ownership", () => {
    const root = makeFixture();
    const path = NodePath.join(root, "docs/fork-features.md");
    NodeFS.rmSync(path);
    expect(runCheck(root, "--base", baseOf(root)).status).toBe(1);
    NodeFS.writeFileSync(path, "```json\n{broken}\n```\n");
    expect(runCheck(root, "--base", baseOf(root)).status).toBe(1);
    writeMap(root, undefined, { id: undefined });
    expect(runCheck(root, "--base", baseOf(root)).output).toContain(
      "invalid or duplicate feature id",
    );
    writeMap(root, ["scripts/fork-upstream-edits.txt", "stale.txt"]);
    expect(runCheck(root, "--base", baseOf(root)).output).toContain(
      "path not allowlisted: stale.txt",
    );
  });
});

function overlap(root: string, base: string, target = "HEAD"): string {
  return NodeChildProcess.execFileSync("node", [forkFeatures, "report", base, target], {
    cwd: root,
    encoding: "utf8",
  });
}

function commitFile(root: string, path: string, content: string, title: string): string {
  NodeFS.writeFileSync(NodePath.join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-qm", title);
  return baseOf(root);
}

describe("upstream overlap report", () => {
  it("matches titles, changed paths and diffs while excluding old and unrelated commits", () => {
    const root = makeFixture();
    commitFile(root, "old.txt", "old", "old child thread");
    const base = baseOf(root);
    const title = commitFile(root, "one.txt", "plain", "CHILD THREAD support");
    const path = commitFile(root, "watched.txt", "plain", "touch watched file");
    const diff = commitFile(root, "two.txt", "parentThreadId", "add linkage");
    const added = commitFile(root, "new-capability.txt", "plain", "new capability");
    const unrelated = commitFile(root, "other.txt", "plain", "unrelated");
    const report = overlap(root, base);
    for (const sha of [title, path, diff, added]) expect(report).toContain(sha);
    expect(report).toContain("keyword (title): child thread");
    expect(report).toContain("file: watched.txt");
    expect(report).toContain("keyword (diff): parentThreadId");
    expect(report).not.toContain("old child thread");
    expect(report).not.toContain(`${unrelated} unrelated`);
    expect(report).toContain("PENDING");
    expect(report).toContain("adopt upstream and delete ours");
    expect(overlap(root, base, base)).toContain("No matches.");
  });

  it("matches deleted/renamed paths and merge changes and groups shared files", () => {
    const root = makeFixture();
    commitFile(root, "watched.txt", "original", "seed");
    const base = baseOf(root);
    const map = NodePath.join(root, "docs/fork-features.md");
    const original = NodeFS.readFileSync(map, "utf8");
    writeMap(root, [], { id: "second" });
    NodeFS.appendFileSync(map, original);
    git(root, "mv", "watched.txt", "renamed.txt");
    git(root, "commit", "-qam", "rename capability");
    const renamed = baseOf(root);
    git(root, "checkout", "-qb", "side");
    const side = commitFile(root, "side.txt", "parentThreadId", "side linkage");
    git(root, "checkout", "-q", "work");
    commitFile(root, "main.txt", "plain", "advance");
    git(root, "merge", "--no-ff", "-qm", "merge feature", "side");
    const merged = baseOf(root);
    const report = overlap(root, base);
    expect(report).toContain("## second");
    expect(report).toContain("## fixture");
    for (const sha of [renamed, side, merged]) expect(report).toContain(sha);
    expect(report).toContain("file: watched.txt");
  });

  it("prints the report before rebase and leaves HEAD unchanged in a dry run", () => {
    const root = makeFixture();
    const base = baseOf(root);
    git(root, "checkout", "-qb", "main");
    commitFile(root, "feature.txt", "parentThreadId", "upstream capability");
    git(root, "checkout", "-q", "work");
    git(root, "remote", "add", "upstream", root);
    const report = NodeChildProcess.execFileSync("bash", [forkRebase, "--dry-run"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(report).toContain("# Upstream overlap report");
    expect(report).toContain("upstream capability");
    expect(report.indexOf("# Upstream overlap report")).toBeLessThan(
      report.indexOf("dry run; nothing changed"),
    );
    expect(baseOf(root)).toBe(base);
  });
});
