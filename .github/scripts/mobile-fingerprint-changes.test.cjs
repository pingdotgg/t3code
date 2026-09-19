const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const script = path.join(__dirname, "mobile-fingerprint-changes.sh");

function fixture(t) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-fingerprint-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const root = path.join(temporaryDirectory, "repo");
  fs.mkdirSync(root);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, text) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  };
  const commit = (message) => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fingerprint test");
  git("config", "user.email", "fingerprint@example.test");
  write("apps/mobile/native.swift", "base native source\n");
  write("packages/effect-acp/client.ts", "base client\n");
  const initial = commit("Initial state");
  git("checkout", "-b", "feature");
  const detect = (cwd = root) => {
    const output = path.join(temporaryDirectory, "output");
    const summary = path.join(temporaryDirectory, "summary");
    fs.writeFileSync(output, "");
    fs.writeFileSync(summary, "");
    execFileSync("bash", [script], {
      cwd,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      encoding: "utf8",
    });
    return Object.fromEntries(
      fs
        .readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  };
  return { root, git, write, commit, initial, detect };
}

test("ignores native changes already on main when the event's base is stale", (t) => {
  const { root, git, write, commit, initial, detect } = fixture(t);
  write("packages/effect-acp/client.ts", "updated client\n");
  commit("ACP change");
  git("checkout", "main");
  write("apps/mobile/native.swift", "updated native source\n");
  const base = commit("Unrelated native change on main");
  git("merge", "--no-ff", "feature", "-m", "Merge feature");
  assert.match(git("diff", "--name-only", initial, "HEAD"), /apps\/mobile\/native\.swift/);
  assert.deepEqual(detect(), { base_sha: base, relevant: "false" });
  const shallowClone = path.join(root, "shallow");
  git("clone", "--quiet", "--depth=2", pathToFileURL(root).href, shallowClone);
  assert.deepEqual(detect(shallowClone), { base_sha: base, relevant: "false" });
});

for (const change of ["native addition", "native deletion", "native rename", "dependency change"]) {
  test(`fingerprints a ${change} and stops after it is reverted`, (t) => {
    const { root, git, write, commit, detect } = fixture(t);
    if (change === "native addition") write("apps/mobile/new.swift", "new native source\n");
    if (change === "native deletion") fs.unlinkSync(path.join(root, "apps/mobile/native.swift"));
    if (change === "native rename") git("mv", "apps/mobile/native.swift", "renamed.swift");
    if (change === "dependency change") write("pnpm-lock.yaml", "updated dependencies\n");
    const changedCommit = commit(change);
    git("checkout", "-b", "snapshot", "main");
    git("merge", "--no-ff", "feature", "-m", "Merge feature");
    assert.equal(detect().relevant, "true");
    git("checkout", "feature");
    git("revert", "--no-edit", changedCommit);
    write("packages/effect-acp/client.ts", "ACP change after revert\n");
    commit("ACP change");
    git("checkout", "main");
    git("merge", "--no-ff", "feature", "-m", "Merge after revert");
    assert.equal(detect().relevant, "false");
  });
}
