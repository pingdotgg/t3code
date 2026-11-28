"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
