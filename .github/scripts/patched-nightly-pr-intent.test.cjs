const assert = require("node:assert/strict");
const test = require("node:test");

const { validatePatchIntent } = require("./patched-nightly-pr-intent.cjs");

const productFiles = ["apps/web/src/components/ChatView.tsx"];

test("does not require a nightly choice for documentation-only changes", () => {
  const result = validatePatchIntent({
    files: ["docs/user/composer.md"],
    title: "docs: explain agent choices",
    body: "",
  });

  assert.deepEqual(result.errors, []);
});

test("requires an explicit choice for product changes", () => {
  const result = validatePatchIntent({
    files: productFiles,
    title: "fix(web): sort agents",
    body: "",
  });

  assert.match(result.errors[0], /Choose exactly one/);
});

test("accepts included changes with the exact patch prefix", () => {
  const result = validatePatchIntent({
    files: productFiles,
    title: "patch: hide settled lineage children",
    body: "- [x] Include this change in patched nightlies\n- [ ] Keep this change out of patched nightlies",
    commits: ["patch: hide settled lineage children", "patch: cover finished children"],
  });

  assert.deepEqual(result.errors, []);
});

test("rejects scoped or ordinary commit prefixes for included patches", () => {
  for (const title of ["patch(web): hide settled children", "fix(web): hide settled children"]) {
    const result = validatePatchIntent({
      files: productFiles,
      title,
      body: "- [x] Include this change in patched nightlies",
      commits: ["patch: hide settled lineage children"],
    });

    assert.match(result.errors[0], /exact PR title format/);
  }
});

test("rejects included PRs with any unprefixed commit", () => {
  for (const unprefixed of [
    "fix(web): update test fixture",
    " patch: leading space is not selected",
  ]) {
    const result = validatePatchIntent({
      files: productFiles,
      title: "patch: hide settled lineage children",
      body: "- [x] Include this change in patched nightlies",
      commits: ["patch: hide settled lineage children", unprefixed],
    });

    assert.match(result.errors[0], /Every commit/);
  }

  const missingCommits = validatePatchIntent({
    files: productFiles,
    title: "patch: hide settled lineage children",
    body: "- [x] Include this change in patched nightlies",
    commits: [],
  });

  assert.match(missingCommits.errors[0], /No commits were returned/);
});

test("accepts a consciously excluded product change without a patch title", () => {
  const result = validatePatchIntent({
    files: productFiles,
    title: "fix(web): adjust fork-only behavior",
    body: "- [x] Keep this change out of patched nightlies",
    commits: ["fix(web): adjust fork-only behavior"],
  });

  assert.deepEqual(result.errors, []);
});

test("rejects conflicting choices and excluded patch titles", () => {
  const bothChecked = validatePatchIntent({
    files: productFiles,
    title: "patch: update behavior",
    body: "- [x] Include this change in patched nightlies\n- [x] Keep this change out of patched nightlies",
    commits: ["patch: update behavior"],
  });
  const excludedPatch = validatePatchIntent({
    files: productFiles,
    title: "patch: update behavior",
    body: "- [x] Keep this change out of patched nightlies",
    commits: ["patch: update behavior"],
  });

  assert.match(bothChecked.errors[0], /Choose exactly one/);
  assert.match(excludedPatch.errors[0], /selected for nightly replay/);
});
