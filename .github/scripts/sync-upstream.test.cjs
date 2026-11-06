const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "sync-upstream.sh");
const budget = "apps/server/src/provider/agentContextBudget.json";
const workflow = ".github/workflows/fork-release.yml";
const gitBash = path.resolve(
  execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
  "../../../bin/bash.exe",
);
const bash = fs.existsSync(gitBash) ? gitBash : "bash";

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-sync-upstream-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  };
  const commit = (message) => {
    git("add", ".");
    git("commit", "-m", message);
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Sync test");
  git("config", "user.email", "sync@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  write(budget, '{"bytes":1}\n');
  write(workflow, "name: original\n");
  write(".github/workflows/removed.yml", "name: keep\n");
  write("source.txt", "original\n");
  commit("base");
  git("branch", "upstream");
  write(budget, '{"bytes":2}\n');
  write(workflow, "name: fork\n");
  commit("fork");
  const before = git("rev-parse", "HEAD");
  git("checkout", "upstream");
  write(budget, '{"bytes":3}\n');
  write(workflow, "name: upstream\n");
  fs.unlinkSync(path.join(cwd, ".github/workflows/removed.yml"));
  write(".github/workflows/added.yml", "name: upstream addition\n");
  write("upstream.txt", "upstream\n");
  commit("upstream");
  git("checkout", "main");
  return {
    cwd,
    git,
    write,
    commit,
    before,
    sync: () =>
      spawnSync(bash, [script.replaceAll("\\", "/"), "upstream"], {
        cwd,
        encoding: "utf8",
      }),
  };
}

test("resolves generated budget and workflow conflicts while preserving the fork workflows", (t) => {
  const { cwd, git, sync, commit, before } = fixture(t);
  const result = sync();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(git("diff", "--cached", before, "--", ".github/workflows"), "");
  assert.equal(fs.readFileSync(path.join(cwd, budget), "utf8"), '{"bytes":3}\n');
  assert.equal(fs.existsSync(path.join(cwd, "upstream.txt")), true);
  assert.equal(git("rev-parse", "MERGE_HEAD"), git("rev-parse", "upstream"));
  commit("sync");
  assert.equal(git("rev-parse", "HEAD^1"), before);
  assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "upstream"));
  const merged = git("rev-parse", "HEAD");
  assert.equal(sync().status, 0);
  assert.equal(git("rev-parse", "HEAD"), merged);
  assert.equal(git("status", "--porcelain"), "");
});

test("aborts source conflicts without changing the fork branch or worktree", (t) => {
  const { cwd, git, write, commit, sync } = fixture(t);
  git("checkout", "upstream");
  write("source.txt", "upstream\n");
  commit("upstream source");
  git("checkout", "main");
  write("source.txt", "fork\n");
  commit("fork source");
  const before = git("rev-parse", "HEAD");
  const result = sync();
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /source\.txt/);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], { cwd }).status, 128);
});
