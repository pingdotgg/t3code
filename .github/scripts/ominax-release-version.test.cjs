const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const script = join(process.cwd(), ".github/scripts/ominax-release-version.sh");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const run = (cwd, commit, event = "workflow_run", ref = "") => {
  const output = join(cwd, "..", "output");
  execFileSync("bash", [script], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF_NAME: ref,
      RELEASE_COMMIT: commit,
      GITHUB_OUTPUT: output,
    },
  });
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
};

test("computes the next learn counter and skips docs-only or already-tagged commits", () => {
  const root = mkdtempSync(join(tmpdir(), "ominax-release-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--bare", bare);
  git(root, "init", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "package.json"), "{}\n");
  require("node:fs").mkdirSync(join(repo, "apps/server"), { recursive: true });
  writeFileSync(join(repo, "apps/server/package.json"), '{"version":"0.1.3"}\n');
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const tagged = git(repo, "rev-parse", "HEAD");
  git(repo, "tag", "v0.1.3-learn.8");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "origin", "HEAD", "--tags");

  writeFileSync(join(repo, "source.ts"), "code\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "code");
  const code = git(repo, "rev-parse", "HEAD");
  assert.deepEqual(run(repo, code), {
    version: "0.1.3-learn.9",
    tag: "v0.1.3-learn.9",
    commit: code,
    skip: "false",
  });

  git(repo, "tag", "v0.1.3-learn.9", code);
  git(repo, "push", "origin", "--tags");
  writeFileSync(join(repo, "notes.md"), "docs\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "docs");
  const docs = git(repo, "rev-parse", "HEAD");
  assert.equal(run(repo, docs).skip, "true");
  assert.equal(run(repo, tagged).skip, "true");
});
