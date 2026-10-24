const assert = require("node:assert/strict");
const test = require("node:test");

const { MAX_MATRIX_JOBS, changedHandles, selectTargets } = require("./pr-vouch-targets.cjs");

function pull(number, login) {
  return { number, user: { login } };
}

test("vouching one author targets only their open PRs", () => {
  const before = "# Trust list\ngithub:alice\ngithub:bob\n";
  const after = "# Trust list\ngithub:alice\ngithub:bob\ngithub:NewContrib\n";
  const pulls = Array.from({ length: 1_300 }, (_, index) => pull(index + 1, `author${index}`));
  pulls.splice(10, 0, pull(5001, "newcontrib"));
  pulls.splice(900, 0, pull(5002, "NewContrib"));

  const { targets, skipped } = selectTargets(pulls, changedHandles(before, after));

  assert.deepEqual(targets, [
    { number: 5001, user: "newcontrib" },
    { number: 5002, user: "NewContrib" },
  ]);
  assert.deepEqual(skipped, []);
});

test("only trust status changes count, not comments, order or reasons", () => {
  const before = [
    "# old header",
    "github:alice",
    "github:bob",
    "-github:carol spam",
    "github:dave",
    "-github:erin spam",
    "github:frank",
  ].join("\n");
  const after = [
    "# new header",
    "github:bob",
    "github:alice",
    "github:carol",
    "-github:dave spam",
    "-github:erin abuse",
    "gitlab:frank",
    "github:grace",
  ].join("\n");

  assert.deepEqual([...changedHandles(before, after)].sort(), ["carol", "dave", "frank", "grace"]);
});

test("handles are read the way the vouch action reads them", () => {
  assert.deepEqual([...changedHandles("", "GitHub:Alice\n")], ["alice"]);
  assert.deepEqual([...changedHandles("github:alice\n", "GITHUB:alice\n")], []);
  assert.deepEqual([...changedHandles("github:bob\n", "-github:bob spam\ngithub:bob\n")], ["bob"]);
  assert.deepEqual([...changedHandles("github:carol\n", "github:carol\n-github:carol spam\n")], []);
  assert.deepEqual([...changedHandles("github:dave\n", "github:dave\tnote\n")].sort(), [
    "dave",
    "dave\tnote",
  ]);
});

test("matching PRs beyond the matrix limit are reported, not dropped silently", () => {
  const pulls = Array.from({ length: MAX_MATRIX_JOBS + 4 }, (_, index) => pull(index + 1, "alice"));

  const { targets, skipped } = selectTargets(pulls, new Set(["alice"]));

  assert.equal(targets.length, MAX_MATRIX_JOBS);
  assert.deepEqual(
    skipped.map((target) => target.number),
    [257, 258, 259, 260],
  );
});

test("a PR without an author does not stop the other PRs from being relabeled", () => {
  const pulls = [pull(1, "alice"), { number: 2, user: null }, pull(3, "alice")];

  const { targets } = selectTargets(pulls, new Set(["alice"]));

  assert.deepEqual(
    targets.map((target) => target.number),
    [1, 3],
  );
});
