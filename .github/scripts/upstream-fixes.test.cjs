"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { batchSize, classify, readSkip, skipped } = require("./upstream-fixes.cjs");

test("accepts only bounded batch sizes", () => {
  assert.equal(batchSize("1"), 1);
  assert.equal(batchSize("12"), 12);
  for (const invalid of ["0", "13", "400", "1.5", "NaN", ""]) {
    assert.throws(() => batchSize(invalid), /integer from 1 to 12/);
  }
});

const commit = (subject, files = ["apps/web/src/a.ts"], body = "") => ({
  sha: "a".repeat(40),
  subject,
  body,
  files,
});

test("takes plain fixes and performance work", () => {
  assert.equal(classify(commit("fix(web): keep the panel open (#1)")).take, true);
  assert.equal(classify(commit("perf(server): cache the lookup")).take, true);
  assert.equal(classify(commit("fix: no scope")).take, true);
});

test("leaves out features, chores and docs", () => {
  for (const subject of [
    "feat(web): new panel",
    "chore: bump",
    "docs(user): copy pass",
    "refactor(server): move",
  ]) {
    assert.equal(classify(commit(subject)).take, false, subject);
  }
});

test("leaves out anything marked breaking", () => {
  assert.equal(classify(commit("fix(server)!: drop the old route")).reason, "breaking");
  assert.equal(
    classify(commit("fix(server): x", undefined, "BREAKING CHANGE: the route moved")).reason,
    "breaking",
  );
});

test("leaves out areas the fork does not carry", () => {
  assert.equal(classify(commit("fix(mobile): side chats")).take, false);
  assert.equal(classify(commit("fix(relay,release): token")).take, false);
  assert.equal(classify(commit("fix(web,mobile): both")).take, true);
});

test("never brings upstream workflows back", () => {
  assert.equal(
    classify(commit("fix(server): x", [".github/workflows/release.yml", "apps/server/a.ts"]))
      .reason,
    "touches .github",
  );
});

test("leaves out fixes that only touch upstream-only paths", () => {
  assert.equal(
    classify(commit("fix(web): x", ["apps/mobile/a.ts", "infra/relay/b.ts"])).take,
    false,
  );
  assert.equal(classify(commit("fix(web): x", ["apps/mobile/a.ts", "apps/web/b.ts"])).take, true);
});

test("reads the skip list with comments and short shas", () => {
  const skip = readSkip("# picked by hand\nabc1234 # breaks our theme\n\nnot-a-sha\n");
  assert.deepEqual([...skip], ["abc1234"]);
  assert.equal(skipped(skip, "abc1234ffff"), true);
  assert.equal(skipped(skip, "def5678"), false);
});

const { addedLines, guard } = require("./upstream-fixes.cjs");

test("holds back a fix that touches a file only the fork writes", () => {
  assert.match(guard(["apps/server/src/telemetry/AnalyticsService.ts"], []), /only this fork/);
  assert.match(guard(["assets/prod/logo.svg"], []), /only this fork/);
  assert.equal(guard(["apps/web/src/a.ts"], []), "");
});

test("holds back a fix that brings upstream's name, hosts or telemetry back", () => {
  const added = (file, line) => [{ file, line }];
  assert.match(guard(["a.ts"], added("apps/web/src/a.ts", 'title: "T3 Code"')), /product name/);
  assert.match(guard(["a.ts"], added("apps/web/src/a.ts", "https://app.t3.codes/x")), /host/);
  assert.match(guard(["a.ts"], added("apps/web/src/a.ts", "https://api.axiom.co")), /telemetry/);
  assert.match(guard(["a.ts"], added("apps/web/src/a.ts", "pingdotgg/t3code")), /repository/);
});

test("keeps internal names and upstream test fixtures", () => {
  const added = (file, line) => [{ file, line }];
  assert.equal(guard(["a.ts"], added("apps/web/src/a.ts", 'from "@t3tools/shared"')), "");
  assert.equal(guard(["a.ts"], added("apps/web/src/a.ts", "HYAKKI_PORT t3code://")), "");
  assert.equal(guard(["a.ts"], added("apps/web/src/a.test.ts", 'repo: "pingdotgg/t3code"')), "");
});

test("reads the added lines of a patch with their files", () => {
  const patch = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.deepEqual(addedLines(patch), [{ file: "x.ts", line: "new" }]);
});

test("lets upstream's name stay in test fixtures", () => {
  const fixture = "apps/server/src/testkit/fixtures/run/transcript.ndjson";
  assert.equal(guard([fixture], [{ file: fixture, line: '"T3 Code session"' }]), "");
});

test("holds back upstream package.json version bumps", () => {
  const added = [{ file: "apps/desktop/package.json", line: '  "version": "0.1.13",' }];
  assert.match(guard(["apps/desktop/package.json"], added), /package version/);
});

test("holds back dedicated vault, PIN and private-read code for manual porting", () => {
  for (const file of [
    "apps/server/src/secrets/SecretRequests.ts",
    "apps/server/src/auth/ServerSecretStore.ts",
    "apps/server/src/auth/VaultCipher.ts",
    "packages/contracts/src/localVault.ts",
    "packages/contracts/src/secretRequest.ts",
    "packages/client-runtime/src/secretRequest.ts",
    "apps/web/src/components/settings/LocalVaultSettings.tsx",
    "apps/web/src/components/settings/VaultPinDialog.tsx",
    "apps/web/src/components/settings/GmailVaultDialog.tsx",
    "apps/web/src/components/settings/privateVaultRoute.ts",
    "apps/web/src/components/chat/PrivateReadRequestCard.tsx",
    "apps/web/src/components/chat/SecretRequestCard.tsx",
  ]) {
    assert.match(guard([file], []), /only this fork/, file);
  }
});

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyakki-upstream-fixes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "repo");
  fs.mkdirSync(directory);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), value);
  };
  const commit = (subject) => {
    git("add", ".");
    git("commit", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main");
  git("config", "user.name", "Upstream fixture");
  git("config", "user.email", "upstream@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(root, "no-hooks"));
  write("apps/web/src/a.ts", "base\n");
  const base = commit("chore: baseline");
  git("branch", "upstream");
  write(".github/upstream-fixes/cursor", `${base}\n`);
  write(".github/upstream-fixes/skip", "abcdef123 # intentionally skipped\n");
  commit("chore: fork checkpoint");
  const run = () =>
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "upstream-fixes.cjs"),
        "upstream",
        "--summary",
        path.join(root, "summary.md"),
      ],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const read = (file) => fs.readFileSync(path.join(directory, file), "utf8");
  return { base, git, write, commit, run, read };
}

test("refuses a dirty worktree before touching local changes or the cursor", (t) => {
  const repo = repository(t);
  repo.git("switch", "upstream");
  repo.write("apps/web/src/branding.ts", "upstream branding\n");
  repo.commit("fix(web): change branding");
  repo.git("switch", "main");
  repo.write("apps/web/src/a.ts", "uncommitted fork work\n");
  const before = repo.git("rev-parse", "HEAD");
  assert.throws(repo.run, /clean worktree/);
  assert.equal(repo.read("apps/web/src/a.ts"), "uncommitted fork work\n");
  assert.equal(repo.read(".github/upstream-fixes/cursor"), `${repo.base}\n`);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
});

test("refuses a cursor outside upstream ancestry without changing history", (t) => {
  const repo = repository(t);
  repo.write(".github/upstream-fixes/cursor", `${repo.git("rev-parse", "HEAD")}\n`);
  const before = repo.commit("chore: invalid cursor");
  assert.throws(repo.run, /ancestor/);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
  assert.equal(repo.git("status", "--porcelain"), "");
});

test("aborts a genuine conflict, keeps the fork version and applies the next safe fix", (t) => {
  const repo = repository(t);
  repo.write("apps/web/src/a.ts", "fork version\n");
  repo.commit("feat: fork behavior");
  repo.git("switch", "upstream");
  repo.write("apps/web/src/a.ts", "upstream version\n");
  repo.commit("fix(web): conflicting change");
  repo.write("apps/web/src/safe.ts", "safe fix\n");
  const last = repo.commit("fix(web): independent safe change");
  repo.git("switch", "main");
  const summary = repo.run();
  assert.match(summary, /Picked 1, did not apply 1/);
  assert.equal(repo.read("apps/web/src/a.ts"), "fork version\n");
  assert.equal(repo.read("apps/web/src/safe.ts"), "safe fix\n");
  assert.equal(repo.read(".github/upstream-fixes/cursor"), `${last}\n`);
  assert.equal(repo.read(".github/upstream-fixes/skip"), "abcdef123 # intentionally skipped\n");
  assert.equal(repo.git("status", "--porcelain"), "");
});

test("holds back a clean vault pick and keeps the following safe fix", (t) => {
  const repo = repository(t);
  repo.git("switch", "upstream");
  repo.write("apps/server/src/secrets/LocalVault.ts", "upstream vault change\n");
  repo.commit("fix(server): replace vault behavior");
  repo.write("apps/web/src/safe.ts", "safe fix\n");
  const last = repo.commit("fix(web): independent safe change");
  repo.git("switch", "main");
  const summary = repo.run();
  assert.match(summary, /Picked 1, did not apply 0, held back 1/);
  assert.throws(() => repo.read("apps/server/src/secrets/LocalVault.ts"), { code: "ENOENT" });
  assert.equal(repo.read("apps/web/src/safe.ts"), "safe fix\n");
  assert.equal(repo.read(".github/upstream-fixes/cursor"), `${last}\n`);
  assert.equal(repo.git("status", "--porcelain"), "");
});

test("stops scanning at 120 commits and resumes the remaining fix on the next run", (t) => {
  const repo = repository(t);
  repo.git("switch", "upstream");
  let checkpoint;
  for (let index = 0; index < 120; index++) checkpoint = repo.commit(`chore: checkpoint ${index}`);
  repo.write("apps/web/src/safe.ts", "later fix\n");
  const last = repo.commit("fix(web): after the scan budget");
  repo.git("switch", "main");
  assert.match(repo.run(), /1 upstream commits are left/);
  assert.equal(repo.read(".github/upstream-fixes/cursor"), `${checkpoint}\n`);
  assert.throws(() => repo.read("apps/web/src/safe.ts"), { code: "ENOENT" });
  assert.match(repo.run(), /Picked 1/);
  assert.equal(repo.read(".github/upstream-fixes/cursor"), `${last}\n`);
  assert.equal(repo.read(".github/upstream-fixes/skip"), "abcdef123 # intentionally skipped\n");
});

test("fails on a fatal cherry-pick error without advancing the cursor", (t) => {
  const repo = repository(t);
  repo.git("switch", "upstream");
  repo.write("apps/web/src/a.ts", "upstream fix\n");
  repo.commit("fix(web): ordinary fix");
  repo.git("switch", "main");
  const before = repo.git("rev-parse", "HEAD");
  repo.git("config", "user.name", "");
  assert.throws(repo.run, /Could not cherry-pick/);
  assert.equal(repo.read(".github/upstream-fixes/cursor"), `${repo.base}\n`);
  assert.equal(repo.git("rev-parse", "HEAD"), before);
});
