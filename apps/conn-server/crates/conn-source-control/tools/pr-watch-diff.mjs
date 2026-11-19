// Pull request watch differential check: T3's `evaluatePullRequestWatch`,
// `pullRequestWatchMessage` and `combinePullRequestWatchWakes`
// (apps/server/src/orchestration-v2/pullRequestWatch.ts) and ours
// (`src/pull_requests/watch.rs`, through `examples/pr_watch_cases.rs`) answer the same cases.
// A case is a watch and a series of host reads; each side feeds its own `next` watch into the
// next read, so a drift in what a watch remembers shows up in a later step.
//
//   node crates/conn-source-control/tools/pr-watch-diff.mjs <examples/pr_watch_cases binary>
import * as NodeChildProcess from "node:child_process";

import { importSource } from "../../../tools/monorepo.mjs";
import { sealedEnvTemp } from "../../../tools/sealed-env.mjs";

const [binary] = process.argv.slice(2);
if (!binary) throw new Error("usage: pr-watch-diff.mjs <examples/pr_watch_cases binary>");

const t3 = await importSource("apps/server/src/orchestration-v2/pullRequestWatch.ts");

// ---- Inputs ------------------------------------------------------------------------------

const STARTED = "2026-10-02T12:00:00.000Z";
const T0 = Date.parse(STARTED);
const MIN = 60_000;
const watch = (extra = {}) => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...extra,
});
const run = (id) => `https://github.com/o/r/actions/runs/${id}`;
const check = (name, status, extra = {}) => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
  ...extra,
});
const capabilities = (checksAlwaysReport) => ({
  diff: true, comment: true, actions: [], mergeMethods: [], search: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  checksAlwaysReport,
});
const detail = (extra = {}) => ({
  capabilities: capabilities(true),
  headSha: "aaaaaaaaaa",
  baseBranch: "main",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...extra,
});
const remark = (login, createdAt, body = "Please rename this.", extra = {}) => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: login === null ? null : { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
  ...extra,
});
const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();
const step = (d, remarks = [], minutes = 1) => ({ detail: d, remarks, now: T0 + minutes * MIN });

const BODIES = [
  "",
  "Please rename this.",
  "<p>Hi <b>there</b></p>",
  "Use `<b>` here, and <i>this</i>.",
  "Vec<code>x</code> stays",
  "a <!-- hidden\nnote --> b",
  "```\n<b>code</b>\n```\n<b>prose</b>",
  "~~~~\n<i>x</i>\n~~~\nstill code\n~~~~\nafter <em>it</em>",
  "text\n    <b>continuation</b>\n\n    <b>indented code</b>",
  "``a ` <b> b``  <span class=\"x>y\">z</span>",
  "<details><summary>More</summary>\n\nInner</details>",
  "<a href='x'>link</a> <unknown>tag</unknown> <br/> <img src=\"a.png\" alt=\"a\">",
  "`` open\n\n<b>blank line</b> ``",
  "x".repeat(250),
  "😀".repeat(120),
  "a".repeat(196) + "😀😀😀",
  "  spaced　words﻿ ",
  "<h1>Title</h1><h7>not</h7>",
];

const cases = [
  ...BODIES.map((body) => ({ kind: "snippet", body })),
  // First read of a fresh watch: the baseline (awaiting all).
  { watch: watch({ awaitingBaseline: "all" }), steps: [
    step(detail()),
    step(detail({ checks: [check("lint", "success"), check("test", "failure")] }), [], 3),
    step(detail({ checks: [check("lint", "success"), check("test", "success")] }), [], 5),
  ] },
  // A watch restarted from an ended one keeps its baseline for checks only.
  { watch: watch({ awaitingBaseline: "checks", headSha: "aaaaaaaaaa" }), steps: [
    step(detail({ headSha: undefined, checks: [] })),
    step(detail({ checks: [check("lint", "failure")] }), [], 2),
    step(detail({ checks: [check("lint", "success")] }), [], 3),
  ] },
  // Checks fail, then a push resets them, then they pass.
  { watch: watch(), steps: [
    step(detail({ checks: [check("a", "failure"), check("b", "cancelled"), check("c", "success")] })),
    step(detail({ checks: [check("a", "failure"), check("b", "cancelled")] }), [], 2),
    step(detail({ headSha: "bbbbbbbbbb", checks: [check("a", "pending")] }), [], 4),
    step(detail({ headSha: "bbbbbbbbbb", checks: [check("a", "success")] }), [], 6),
  ] },
  // Required checks pass while advisory ones still run: one more wake when they settle.
  { watch: watch(), steps: [
    step(detail({ checks: [check("req", "success", { required: true }), check("adv", "pending")] })),
    step(detail({ checks: [check("req", "success", { required: true }), check("adv", "success")] }), [], 2),
    step(detail({ checks: [check("req", "success", { required: true }), check("req2", "success", { required: true }), check("adv", "success")] }), [], 3),
  ] },
  // Many failed checks list ten and count the rest.
  { watch: watch(), steps: [
    step(detail({ checks: Array.from({ length: 13 }, (_, i) => check(`job-${i}`, "failure", i % 2 ? { url: null } : {})) })),
  ] },
  // Runs awaiting approval, keyed by workflow run, held until their jobs finish.
  { watch: watch(), steps: [
    step(detail({ checks: [check("build", "action-required", { url: `${run(5)}/job/1` }), check("lint", "success")] })),
    step(detail({ checks: [check("lint", "success")] }), [], 2),
    step(detail({ checks: [check("build", "pending", { url: `${run(5)}/job/2` }), check("lint", "success")] }), [], 3),
    step(detail({ checks: [check("build", "success", { url: `${run(5)}/job/2` }), check("lint", "success")] }), [], 4),
    step(detail({ checks: [check("gate", "action-required", { url: null }), check("lint", "success")] }), [], 5),
    step(detail({ checks: [check("lint", "success")] }), [], 6),
  ] },
  // Placeholder (unread) checks never establish success.
  { watch: watch(), steps: [
    step(detail({ checks: [check("x", "success"), check("approval", "pending", { placeholder: true })] })),
    step(detail({ checks: [check("x", "success")] }), [], 2),
  ] },
  // No checks for 15 minutes on a host that always reports them; and on one that does not.
  { watch: watch({ awaitingBaseline: "all" }), steps: [
    step(detail({ checks: [] }), [], 0),
    step(detail({ checks: [] }), [], 10),
    step(detail({ checks: [] }), [], 16),
    step(detail({ checks: [] }), [], 40),
  ] },
  { watch: watch({ awaitingBaseline: "all" }), steps: [
    step(detail({ capabilities: capabilities(false), checks: [] }), [], 0),
    step(detail({ capabilities: capabilities(false), checks: [] }), [], 20),
  ] },
  // Remarks: own ones and old ones never wake; equal timestamps are told apart by id.
  { watch: watch(), steps: [
    step(detail({ checks: [check("t", "success")] }), [
      remark("reviewer", at(-5)),
      remark("agent-user", at(1)),
      remark("Reviewer", at(1), "<b>Fix</b> this"),
      remark("bot", at(1), "", { reviewState: "approved", path: null }),
      remark(null, at(1), "anon"),
    ]),
    step(detail({ checks: [check("t", "success")] }), [
      remark("Reviewer", at(1), "<b>Fix</b> this"),
      remark("other", at(1), "Same second"),
      remark("late", at(2), "Edited", { editedAt: at(3) }),
    ], 4),
  ] },
  // Comment-only wakes stop the watch after ten in a row.
  { watch: watch({ wakes: 8 }), steps: [
    step(detail({ checks: [check("t", "success")] }), [remark("r", at(1))]),
    step(detail({ checks: [check("t", "success")] }), [remark("r", at(1)), remark("r", at(2))], 3),
  ] },
  // Many remarks list ten.
  { watch: watch(), steps: [
    step(detail({ checks: [check("t", "success")] }), Array.from({ length: 12 }, (_, i) => remark(`r${i}`, at(1), `Note ${i}`))),
  ] },
  // Conflicts and rebases: told once per head, cleared only by a clean answer.
  { watch: watch(), steps: [
    step(detail({ mergeability: "conflicting", rebaseRequired: true })),
    step(detail({ mergeability: "unknown" }), [], 2),
    step(detail({ mergeability: "conflicting", rebaseRequired: true }), [], 3),
    step(detail({ mergeability: "mergeable", rebaseRequired: false }), [], 4),
    step(detail({ mergeability: "conflicting", rebaseRequired: true }), [], 5),
    step(detail({ headSha: "cccccccccc", mergeability: "conflicting", rebaseRequired: true }), [], 6),
  ] },
  { watch: watch({ awaitingBaseline: "all" }), steps: [
    step(detail({ mergeability: "conflicting", rebaseRequired: true })),
  ] },
  // Merge queue removals: historical ones are baseline, merged ones never wake.
  { watch: watch(), steps: [
    step(detail({ mergeQueueRemoval: { id: "q1", reason: "checks failed", removedAt: "2026-10-02T11:00:00Z" } })),
    step(detail({ mergeQueueRemoval: { id: "q2", reason: null, removedAt: at(2) } }), [], 3),
    step(detail({ mergeQueueRemoval: { id: "q3", reason: "merged", removedAt: at(4) } }), [], 5),
  ] },
  { watch: watch(), steps: [
    step(detail({ mergeQueueRemoval: { id: "q9", reason: "conflict", removedAt: "2026-10-02T12:00:00.500Z" } })),
  ] },
  // A read without a head keeps the last known one.
  { watch: watch({ headSha: "dddddddddd", checksPending: true }), steps: [
    step(detail({ headSha: null, checks: [] })),
    step(detail({ headSha: undefined, checks: [check("t", "success")] }), [], 2),
  ] },
  // A legacy watch without checksPending and with a running clock.
  { watch: watch({ checksAwaitedSince: at(-20) }), steps: [step(detail({ checks: [] }))] },
  // Viewer falls back to the author; one check passes alone.
  { watch: watch(), number: 42, url: "https://github.com/o/r/pull/42", steps: [
    step(detail({ viewer: null, checks: [check("only", "success")] }), [remark("agent-user", at(1))]),
  ] },
  // Several changes in one read, for the outcome and summary.
  { watch: watch({ headSha: "aaaaaaaaaa" }), steps: [
    step(detail({ checks: [check("x", "failure")], mergeability: "conflicting" }), [remark("r", at(1))]),
  ] },
];

const sample = (number, text, outcome, summary) => ({
  text, notification: { source: { kind: "monitor" }, outcome, summary: `#${number}: ${summary}` },
});
const closing = (number) =>
  t3.pullRequestWatchMessage({
    number, url: `https://github.com/o/r/pull/${number}`, baseBranch: "main", headSha: "abcdef12345",
    report: { changes: [{ kind: "conflicting" }], next: watch(), exhausted: false },
  });
cases.push(
  { kind: "combine", wakes: [closing(1)] },
  { kind: "combine", wakes: [closing(1), closing(2)] },
  { kind: "combine", wakes: [sample(3, "plain", "completed", "checks passed"), sample(4, "plain", "completed", "checks passed")] },
  { kind: "combine", wakes: [sample(3, "plain", "completed", "checks passed"), closing(5), sample(6, "x", "updated", "new comments")] },
);

// ---- T3's answers ------------------------------------------------------------------------

function t3Answer(input) {
  if (input.kind === "snippet") {
    // `snippet` is private; a one-remark message carries it verbatim.
    const wake = t3.pullRequestWatchMessage({
      number: 1, url: "u", baseBranch: "main", headSha: null,
      report: { changes: [{ kind: "remarks", remarks: [remark("r", STARTED, input.body, { url: null, path: null })] }], next: watch(), exhausted: false },
    });
    const line = wake.text.split("\n")[2];
    const said = line.slice("  - r: ".length);
    return said === "reviewed" ? "" : said.slice(1, -1);
  }
  if (input.kind === "combine") return t3.combinePullRequestWatchWakes(input.wakes);
  let current = input.watch;
  return input.steps.map(({ detail: d, remarks, now }) => {
    const report = t3.evaluatePullRequestWatch(current, d, remarks, now);
    const wake = report.changes.length === 0 ? null : t3.pullRequestWatchMessage({
      number: input.number ?? 1, url: input.url ?? "", baseBranch: d.baseBranch ?? "main",
      headSha: report.next.headSha, report,
    });
    current = report.next;
    return { changes: report.changes, next: report.next, exhausted: report.exhausted, wake };
  });
}

// ---- Compare -----------------------------------------------------------------------------

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => [k, canonical(value[k])]))
      : value;

// JSON drops `undefined`, as both sides see the inputs.
const wire = JSON.parse(JSON.stringify(cases));
const expected = wire.map(t3Answer);
const result = NodeChildProcess.spawnSync(binary, [], {
  input: JSON.stringify(wire.map((c) => ({ kind: c.kind ?? "evaluate", ...c }))),
  env: sealedEnvTemp(),
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error(result.stderr.toString());
  throw new Error(`${binary} exited ${result.status}`);
}
const actual = JSON.parse(result.stdout.toString());
let failures = 0;
wire.forEach((input, index) => {
  const want = JSON.stringify(canonical(expected[index]));
  const got = JSON.stringify(canonical(actual[index]));
  if (want !== got) {
    failures += 1;
    console.error(`case ${index} (${input.kind ?? "evaluate"}) differs\n  T3:   ${want}\n  ours: ${got}`);
  }
});
const steps = wire.reduce((n, c) => n + (c.steps?.length ?? 1), 0);
if (failures > 0) {
  console.error(`pr-watch-diff: ${failures} of ${wire.length} cases differ`);
  process.exit(1);
}
console.log(`pr-watch-diff: ${wire.length} cases (${steps} reads) agree with T3`);
