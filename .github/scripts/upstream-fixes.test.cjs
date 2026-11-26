"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, readSkip, skipped } = require("./upstream-fixes.cjs");

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
