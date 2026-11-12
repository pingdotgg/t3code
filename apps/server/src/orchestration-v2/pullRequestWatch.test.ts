import {
  type PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch as evaluate,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

// These cases read the head once or at one moment, so the no-checks notice never comes due.
const evaluatePullRequestWatch = (
  ...args: Parameters<typeof evaluate> extends [...infer Head, number] ? Head : never
) => evaluate(...args, 0);

const STARTED = "2026-10-02T12:00:00.000Z";

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const run = (id: number) => `https://github.com/o/r/actions/runs/${id}`;

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const capabilities = (checksAlwaysReport: boolean): Detail["capabilities"] => ({
  diff: true,
  comment: true,
  actions: [],
  mergeMethods: [],
  search: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  checksAlwaysReport,
});

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  capabilities: capabilities(true),
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (
  login: string,
  createdAt: string,
  body = "Please rename this.",
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

const noRemarks: ReadonlyArray<PullRequestComment> = [];

describe("evaluatePullRequestWatch", () => {
  it("waits for workflow approval once, through reads that miss it, until the run finishes", () => {
    const bot = check("bot", "success");
    const approval = { ...check("CI", "action-required"), url: run(1) };
    const gated = detail({ checks: [bot, approval] });
    const first = evaluatePullRequestWatch(watch(), gated, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-awaiting-approval", checks: [approval] }]);

    // GitHub's approval read can answer empty while the rest of the checks read fine.
    const missing = evaluatePullRequestWatch(first.next, detail({ checks: [bot] }), noRemarks);
    assert.deepEqual(missing.changes, []);
    assert.isFalse(missing.next.passed);
    assert.deepEqual(evaluatePullRequestWatch(missing.next, gated, noRemarks).changes, []);
    const later = { ...check("Preview", "action-required"), url: run(2) };
    assert.deepEqual(
      evaluatePullRequestWatch(missing.next, detail({ checks: [bot, approval, later] }), noRemarks)
        .changes,
      [],
    );
    const unnamed = { ...check("Docs", "action-required"), url: null };
    const named = detail({ checks: [bot, unnamed] });
    const alone = evaluatePullRequestWatch(watch(), named, noRemarks);
    assert.deepEqual(alone.changes, [{ kind: "checks-awaiting-approval", checks: [unnamed] }]);
    const placeholder = { ...unnamed, name: "Workflow approval status", placeholder: true };
    const unlisted = evaluatePullRequestWatch(
      alone.next,
      detail({ checks: [bot, placeholder] }),
      noRemarks,
    );
    assert.deepEqual(unlisted.changes, []);
    assert.isFalse(unlisted.next.passed);
    assert.deepEqual(evaluatePullRequestWatch(unlisted.next, named, noRemarks).changes, []);
    const dropped = evaluatePullRequestWatch(alone.next, detail({ checks: [bot] }), noRemarks);
    assert.deepEqual(dropped.changes, []);
    assert.isFalse(dropped.next.passed);
    assert.deepEqual(dropped.next.awaitingApproval, [unnamed.name]);
    assert.deepEqual(evaluatePullRequestWatch(dropped.next, named, noRemarks).changes, []);
    const namedPending = evaluatePullRequestWatch(
      dropped.next,
      detail({
        checks: [
          { ...bot, required: true },
          { ...unnamed, status: "pending" },
        ],
      }),
      noRemarks,
    );
    assert.deepEqual(namedPending.changes, []);
    assert.isFalse(namedPending.next.passed);
    const namedDone = detail({ checks: [bot, { ...unnamed, status: "success" }] });
    const namedFinished = evaluatePullRequestWatch(namedPending.next, namedDone, noRemarks);
    assert.deepEqual(namedFinished.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(namedFinished.next.awaitingApproval, []);
    assert.deepEqual(
      evaluatePullRequestWatch(namedFinished.next, namedDone, noRemarks).changes,
      [],
    );
    const pushed = detail({ headSha: "bbbbbbbbbb", checks: [bot] });
    assert.deepEqual(evaluatePullRequestWatch(missing.next, pushed, noRemarks).changes, [
      { kind: "checks-passed", count: 1, required: false },
    ]);

    // Approved, the run's jobs carry their own names under the run's URL.
    const job = { ...check("lint", "success"), url: `${run(1)}/job/7` };
    const pending = { ...check("test", "pending"), url: `${run(1)}/job/8` };
    const required = { ...bot, required: true };
    const running = evaluatePullRequestWatch(
      missing.next,
      detail({ checks: [required, job, pending] }),
      noRemarks,
    );
    assert.deepEqual(running.changes, []);
    assert.isFalse(running.next.passed);
    assert.deepEqual(running.next.awaitingApproval, [run(1)]);
    const overlap = evaluatePullRequestWatch(
      running.next,
      detail({ checks: [required, job, { ...pending, url: `${run(2)}/job/9` }] }),
      noRemarks,
    );
    assert.deepEqual(overlap.changes, []);
    assert.isFalse(overlap.next.passed);
    assert.deepEqual(overlap.next.awaitingApproval, [run(1)]);
    const unlinked = evaluatePullRequestWatch(
      overlap.next,
      detail({ checks: [required, job, { ...pending, url: null }] }),
      noRemarks,
    );
    assert.deepEqual(unlinked.changes, []);
    assert.isFalse(unlinked.next.passed);
    assert.deepEqual(unlinked.next.awaitingApproval, [run(1)]);
    const advisory = evaluatePullRequestWatch(
      unlinked.next,
      detail({ checks: [required, job, { ...pending, url: "https://ci.example/test" }] }),
      noRemarks,
    );
    assert.deepEqual(advisory.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(advisory.next.awaitingApproval, []);
    const completed = detail({ checks: [required, job, { ...pending, status: "success" }] });
    const finished = evaluatePullRequestWatch(unlinked.next, completed, noRemarks);
    assert.deepEqual(finished.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(finished.next.awaitingApproval, []);
    assert.deepEqual(evaluatePullRequestWatch(finished.next, completed, noRemarks).changes, []);

    const done = evaluatePullRequestWatch(missing.next, detail({ checks: [bot, job] }), noRemarks);
    assert.deepEqual(done.changes, [{ kind: "checks-passed", count: 2, required: false }]);
  });

  it("does not pass or fail while the host cannot tell whether workflows await approval", () => {
    const bot = check("bot", "success");
    const unknown = {
      ...check("Workflow approval status", "action-required"),
      url: null,
      placeholder: true,
    };
    const unread = evaluatePullRequestWatch(watch(), detail({ checks: [bot, unknown] }), noRemarks);
    assert.deepEqual(unread.changes, []);
    assert.isFalse(unread.next.passed);
    const read = evaluatePullRequestWatch(unread.next, detail({ checks: [bot] }), noRemarks);
    assert.deepEqual(read.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const blocked = evaluatePullRequestWatch(
      read.next,
      detail({ checks: [{ ...bot, status: "pending" }, unknown] }),
      noRemarks,
    );
    assert.isFalse(blocked.next.passed);
    assert.deepEqual(
      evaluatePullRequestWatch(blocked.next, detail({ checks: [bot] }), noRemarks).changes,
      [{ kind: "checks-passed", count: 1, required: false }],
    );
  });

  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(evaluatePullRequestWatch(lint.next, first, noRemarks).changes, []);

    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks);
    assert.equal(evaluatePullRequestWatch(rerun.next, second, noRemarks).changes.length, 1);

    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(evaluatePullRequestWatch(test.next, pushed, noRemarks).changes.length, 1);

    const approval = { ...check("CI", "action-required"), url: run(1) };
    const gated = detail({ checks: [approval, check("lint", "failure")] });
    assert.deepEqual(evaluatePullRequestWatch(watch(), gated, noRemarks).changes, [
      { kind: "checks-failed", failed: [check("lint", "failure")] },
      { kind: "checks-awaiting-approval", checks: [approval] },
    ]);
  });

  it("reports passed once the required checks pass, whatever the others do", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const green = detail({
      checks: [required("test", "success"), required("lint", "success"), check("bot", "pending")],
    });
    const passed = evaluatePullRequestWatch(watch(), green, noRemarks);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(passed.next, green, noRemarks).changes, []);

    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(evaluatePullRequestWatch(watch(), plain, noRemarks).changes, []);
  });

  it("reports passed again when a required check shows up already passed", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const tests = detail({
      checks: [required("Tests", "success"), check("Smoke Tests", "pending")],
    });
    const first = evaluatePullRequestWatch(watch(), tests, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    const gated = detail({
      checks: [
        required("Tests", "success"),
        check("Smoke Tests", "success"),
        required("Smoke Tests Gate", "success"),
      ],
    });
    const second = evaluatePullRequestWatch(first.next, gated, noRemarks);
    assert.deepEqual(second.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(second.next, gated, noRemarks).changes, []);

    const pending = detail({
      checks: [required("Tests", "success"), required("Smoke Tests Gate", "pending")],
    });
    const waiting = evaluatePullRequestWatch(first.next, pending, noRemarks);
    assert.deepEqual(waiting.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(waiting.next, gated, noRemarks).changes, [
      { kind: "checks-passed", count: 2, required: true },
    ]);
  });

  // regression: #23712 required checks woke the agent early and the rest finishing never did
  it("wakes again when the other checks finish after the required ones passed", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const early = detail({
      checks: [required("test", "success"), check("e2e", "pending")],
    });
    const first = evaluatePullRequestWatch(watch(), early, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    const done = detail({
      checks: [required("test", "success"), check("e2e", "success")],
    });
    const final = evaluatePullRequestWatch(first.next, done, noRemarks);
    assert.deepEqual(
      final.changes.map((change) => change.kind),
      ["checks-passed"],
    );
    assert.deepEqual(evaluatePullRequestWatch(final.next, done, noRemarks).changes, []);
    // A later advisory job running and passing is not more news.
    const botPending = detail({ checks: [...done.checks, check("bot", "pending")] });
    const churn = evaluatePullRequestWatch(final.next, botPending, noRemarks);
    assert.deepEqual(churn.changes, []);
    const botDone = detail({ checks: [...done.checks, check("bot", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(churn.next, botDone, noRemarks).changes, []);

    // A pending check that turns required on the next read still finishes with one wake.
    const promoted = detail({
      checks: [required("test", "success"), required("e2e", "success")],
    });
    const gated = evaluatePullRequestWatch(first.next, promoted, noRemarks);
    assert.deepEqual(gated.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(gated.next, promoted, noRemarks).changes, []);

    // Nothing else was pending when the required ones passed, so nothing more is owed.
    const green = evaluatePullRequestWatch(watch(), done, noRemarks);
    assert.deepEqual(green.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(green.next, botDone, noRemarks).changes, []);
  });

  it("reports an owed all-checks result when a rerun also settles the others", () => {
    const required = (url: string) => ({
      ...check("test", "success"),
      url,
      required: true,
    });
    const e2e = (status: PullRequestCheck["status"], url = "https://ci.example/e2e") => ({
      ...check("e2e", status),
      url,
    });
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [required(run(1)), e2e("pending")] }),
      noRemarks,
    );
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(first.next.owedChecks, ["e2e"]);

    // The required rerun and the owed advisory settle in the same read: deliver one completion.
    const settled = detail({ checks: [required(run(2)), e2e("success")] });
    const final = evaluatePullRequestWatch(first.next, settled, noRemarks);
    assert.deepEqual(final.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(final.next.owedChecks, []);
    assert.deepEqual(evaluatePullRequestWatch(final.next, settled, noRemarks).changes, []);

    const expanded = detail({
      checks: [
        required(run(2)),
        e2e("success"),
        {
          ...check("new gate", "success"),
          required: true,
        },
      ],
    });
    const expandedRead = evaluatePullRequestWatch(first.next, expanded, noRemarks);
    assert.deepEqual(expandedRead.changes, [{ kind: "checks-passed", count: 3, required: false }]);
    assert.deepEqual(expandedRead.next.owedChecks, []);
    assert.deepEqual(evaluatePullRequestWatch(expandedRead.next, expanded, noRemarks).changes, []);

    // A rerun before the owed check settles keeps its debt for the later wake.
    const rerun = evaluatePullRequestWatch(
      first.next,
      detail({ checks: [required(run(3)), e2e("pending")] }),
      noRemarks,
    );
    assert.deepEqual(rerun.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(rerun.next.owedChecks, ["e2e"]);
    const settledRerun = detail({ checks: [required(run(3)), e2e("success")] });
    assert.deepEqual(evaluatePullRequestWatch(rerun.next, settledRerun, noRemarks).changes, [
      { kind: "checks-passed", count: 2, required: false },
    ]);
  });

  it("does not wake again for a stable duplicate check name with distinct URLs", () => {
    const pipeline = (url: string): PullRequestCheck => ({ ...check("Pipeline", "success"), url });
    const firstUrl = "https://gitlab.example/pipelines/1";
    const secondUrl = "https://gitlab.example/pipelines/2";
    const checks = [pipeline(firstUrl), pipeline(secondUrl)];
    const first = evaluatePullRequestWatch(watch(), detail({ checks }), noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(first.next.passedCheckRuns, [
      { name: "Pipeline", url: firstUrl },
      { name: "Pipeline", url: secondUrl },
    ]);
    const again = evaluatePullRequestWatch(first.next, detail({ checks }), noRemarks);
    assert.deepEqual(again.changes, []);
    assert.deepEqual(again.next.passedCheckRuns, first.next.passedCheckRuns);

    // A new advisory name has no baseline identity, so it is not a rerun of one.
    const grown = detail({ checks: [...checks, check("downstream", "success")] });
    const growth = evaluatePullRequestWatch(again.next, grown, noRemarks);
    assert.deepEqual(growth.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(growth.next, grown, noRemarks).changes, []);

    // One duplicate reruns: its new URL is news once, then quiet.
    const rerun = [pipeline("https://gitlab.example/pipelines/3"), pipeline(secondUrl)];
    const rerunRead = evaluatePullRequestWatch(growth.next, detail({ checks: rerun }), noRemarks);
    assert.deepEqual(rerunRead.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(
      evaluatePullRequestWatch(rerunRead.next, detail({ checks: rerun }), noRemarks).changes,
      [],
    );
  });

  it("keeps stage baselines through a partial pipeline read so a later rerun still wakes", () => {
    const stage = (job: string, url: string): PullRequestCheck => ({
      ...check(`build / ${job}`, "success"),
      url,
    });
    const testUrl = "https://gitlab.example/jobs/1";
    const deployUrl = "https://gitlab.example/jobs/2";
    const full = detail({ checks: [stage("test", testUrl), stage("deploy", deployUrl)] });
    const first = evaluatePullRequestWatch(watch(), full, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 2, required: false }]);

    // A URL-less partial read cannot identify a rerun, so it keeps every baseline.
    const unaddressed = evaluatePullRequestWatch(
      first.next,
      detail({ checks: [{ ...check("Pipeline", "success"), url: null }] }),
      noRemarks,
    );
    assert.deepEqual(unaddressed.changes, []);
    assert.deepEqual(unaddressed.next.passedCheckRuns, first.next.passedCheckRuns);

    // The stage read falls back to one passing pipeline check, which changes no known name.
    const fallback = detail({
      checks: [{ ...check("Pipeline", "success"), url: "https://gitlab.example/pipelines/9" }],
    });
    const fallbackRead = evaluatePullRequestWatch(unaddressed.next, fallback, noRemarks);
    assert.deepEqual(fallbackRead.changes, []);
    assert.deepEqual(fallbackRead.next.passedCheckRuns, [
      { name: "build / test", url: testUrl },
      { name: "build / deploy", url: deployUrl },
      { name: "Pipeline", url: "https://gitlab.example/pipelines/9" },
    ]);
    const fallbackAgain = evaluatePullRequestWatch(fallbackRead.next, fallback, noRemarks);
    assert.deepEqual(fallbackAgain.changes, []);
    assert.lengthOf(fallbackAgain.next.passedCheckRuns ?? [], 3);

    // Full jobs return after a rerun of one existing name: its new URL is a successful rerun.
    const rerun = detail({
      checks: [stage("test", "https://gitlab.example/jobs/3"), stage("deploy", deployUrl)],
    });
    const rerunRead = evaluatePullRequestWatch(fallbackAgain.next, rerun, noRemarks);
    assert.deepEqual(rerunRead.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(evaluatePullRequestWatch(rerunRead.next, rerun, noRemarks).changes, []);
  });

  it("reports an owed non-required failure once after the required notice", () => {
    const required = { ...check("test", "success"), required: true };
    const early = detail({ checks: [required, check("e2e", "pending")] });
    const first = evaluatePullRequestWatch(watch(), early, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    const failed = detail({ checks: [required, check("e2e", "failure")] });
    const failure = evaluatePullRequestWatch(first.next, failed, noRemarks);
    assert.deepEqual(failure.changes, [
      { kind: "checks-failed", failed: [check("e2e", "failure")] },
    ]);
    const repeated = evaluatePullRequestWatch(failure.next, failed, noRemarks);
    assert.deepEqual(repeated.changes, []);
    const recovered = detail({ checks: [required, check("e2e", "success")] });
    const final = evaluatePullRequestWatch(repeated.next, recovered, noRemarks);
    assert.deepEqual(final.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(evaluatePullRequestWatch(final.next, recovered, noRemarks).changes, []);
  });

  it("clears old-head owed checks when a new head is pushed", () => {
    const required = { ...check("test", "success"), required: true };
    const early = detail({ checks: [required, check("e2e", "pending")] });
    const first = evaluatePullRequestWatch(watch(), early, noRemarks);
    assert.deepEqual(first.next.owedChecks, ["e2e"]);
    const unreadHead = detail({ headSha: "bbbbbbbbbb", checks: [] });
    const unread = evaluatePullRequestWatch(first.next, unreadHead, noRemarks);
    assert.deepEqual(unread.changes, []);
    assert.deepEqual(unread.next.owedChecks, []);
    const pushed = detail({ ...unreadHead, checks: [required] });
    const newHead = evaluatePullRequestWatch(unread.next, pushed, noRemarks);
    assert.deepEqual(newHead.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(newHead.next.owedChecks, []);
    const lateResult = detail({ ...pushed, checks: [required, check("e2e", "success")] });
    const final = evaluatePullRequestWatch(newHead.next, lateResult, noRemarks);
    assert.deepEqual(final.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(final.next, lateResult, noRemarks).changes, []);
  });

  // regression: #16208 PR watches burned GitHub's rate limit and gave up
  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("test", "success")] }),
      noRemarks,
    );
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(first.next, both, noRemarks).changes, []);
  });

  it("does not wake a watch saved before passed checks were recorded", () => {
    const green = detail({ checks: [{ ...check("test", "success"), required: true }] });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true });
    const saved = evaluatePullRequestWatch(told, green, noRemarks);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later pass when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluatePullRequestWatch(watch(), detail(), null);
    assert.deepEqual(partial.changes, []);
    assert.equal(
      evaluatePullRequestWatch(partial.next, detail(), comments).changes[0]?.kind,
      "remarks",
    );
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluatePullRequestWatch(watch(), detail(), [first]);
    const again = evaluatePullRequestWatch(reported.next, detail(), [first, late]);
    assert.deepEqual(again.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(again.next.remarkIds, [first.id, "late"]);
  });

  it("reports edits after the watermark once and counts them toward the wake limit", () => {
    const old = remark("greptile[bot]", "2026-10-02T11:00:00Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarkIds: [old.id],
      wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
    });
    assert.deepEqual(evaluatePullRequestWatch(watching, detail(), [old]).changes, []);
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluatePullRequestWatch(watching, detail(), [edited]);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.deepEqual(report.next.remarkIds, [old.id]);
    assert.isTrue(report.exhausted);
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited]).changes, []);
    const late = { ...edited, id: "late" };
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited, late]).changes, [
      { kind: "remarks", remarks: [late] },
    ]);
  });

  it("wakes once per edit of a remark seen at the watermark, never for the agent's own", () => {
    const seen = remark("ci-bot", "2026-10-10T19:52:40.000Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarksThrough: seen.createdAt,
      remarkIds: [seen.id],
      wakes: 2,
    });
    assert.deepEqual(evaluatePullRequestWatch(watching, detail(), [seen]).changes, []);
    const edited = { ...seen, editedAt: "2026-10-10T20:04:50.000Z" };
    const first = evaluatePullRequestWatch(watching, detail(), [edited]);
    assert.deepEqual(first.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.strictEqual(first.next.remarksThrough, edited.editedAt);
    assert.deepEqual(evaluatePullRequestWatch(first.next, detail(), [edited]).changes, []);
    const again = { ...seen, editedAt: "2026-10-10T20:05:50.000Z" };
    const second = evaluatePullRequestWatch(first.next, detail(), [again]);
    assert.deepEqual(second.changes, [{ kind: "remarks", remarks: [again] }]);
    assert.deepEqual(evaluatePullRequestWatch(second.next, detail(), [again]).changes, []);
    const own = { ...edited, author: { login: "agent-user", name: null, avatarUrl: null } };
    assert.deepEqual(evaluatePullRequestWatch(watching, detail(), [own]).changes, []);
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluatePullRequestWatch(watch(), failed, noRemarks);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluatePullRequestWatch(reported.next, detail({ checks: [] }), noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(unreadable.next, failed, noRemarks).changes, []);
  });

  it("wakes for the pull request's author when the agent is someone else", () => {
    const contributor = detail({ author: { login: "contributor", name: null, avatarUrl: null } });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(watch(), contributor, [reply]).changes, [
      { kind: "remarks", remarks: [reply] },
    ]);
    const noViewer = detail({ viewer: undefined, author: contributor.author });
    assert.deepEqual(evaluatePullRequestWatch(watch(), noViewer, [reply]).changes, []);
  });

  it("reports remarks from others once and never the agent's own", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    const report = evaluatePullRequestWatch(watch(), detail(), comments);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), comments).changes, []);
  });

  it("cuts a long remark in the wake message without splitting an emoji", () => {
    const body = `${"x".repeat(196)}🚀 and more`;
    const report = evaluatePullRequestWatch(watch(), detail(), [
      remark("reviewer", "2026-10-02T12:06:00Z", body),
    ]);
    const { text } = pullRequestWatchMessage({
      number: 1,
      url: "https://github.com/o/r/pull/1",
      baseBranch: "main",
      headSha: null,
      report,
    });
    assert.isTrue(text.isWellFormed());
    assert.include(text, `"${"x".repeat(196)}..."`);
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    const { headSha: _unreadHead, ...headUnread } = conflicting;
    const unread = evaluatePullRequestWatch(first.next, headUnread, noRemarks);
    assert.deepEqual(unread.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(unread.next, conflicting, noRemarks).changes, []);
    const recomputing = evaluatePullRequestWatch(
      first.next,
      detail({ mergeability: "unknown" }),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(recomputing.next, conflicting, noRemarks).changes,
      [],
    );
    const clean = evaluatePullRequestWatch(first.next, detail(), noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(clean.next, conflicting, noRemarks).changes, [
      { kind: "conflicting" },
    ]);
    const pushed = { headSha: "bbbbbbbbbb" };
    const recomputed = evaluatePullRequestWatch(
      first.next,
      detail({ ...pushed, mergeability: "unknown" }),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(
        recomputed.next,
        detail({ ...pushed, mergeability: "conflicting" }),
        noRemarks,
      ).changes,
      [{ kind: "conflicting" }],
    );
  });

  it("does not spend the comment wake limit on check results", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(
      tired,
      detail({ checks: [check("lint", "failure")] }),
      noRemarks,
    );
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("stops after the wake limit unless the head moves", () => {
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.isTrue(evaluatePullRequestWatch(tired, detail(), comments).exhausted);
    const pushed = evaluatePullRequestWatch(tired, detail({ headSha: "cccccccccc" }), comments);
    assert.isFalse(pushed.exhausted);
    assert.equal(pushed.next.wakes, 1);
  });

  const anHourLater = (
    first: ThreadPullRequestWatch,
    read: Detail,
  ): ReadonlyArray<ReadonlyArray<string>> => {
    const kinds: Array<ReadonlyArray<string>> = [];
    let current = first;
    for (let minute = 0; minute <= 60; minute += 10) {
      const { changes, next } = evaluate(current, read, noRemarks, minute * 60_000);
      kinds.push(changes.map((change) => change.kind));
      current = next;
    }
    return kinds;
  };

  it("does not tell a watch saved before the no-checks clock that its seen head has none", () => {
    // Such a watch may have seen this head's checks pending, which records nothing.
    const legacy = watch({ headSha: "aaaaaaaaaa" });
    assert.isTrue(anHourLater(legacy, detail({ checks: [] })).every((kinds) => kinds.length === 0));
    const pushed = anHourLater(legacy, detail({ headSha: "bbbbbbbbbb", checks: [] }));
    assert.deepEqual(pushed.flat(), ["no-checks"]);
    const unknown = detail({
      checks: [{ ...check("Workflow approval status", "action-required"), placeholder: true }],
    });
    assert.deepEqual(anHourLater(watch(), unknown).flat(), []);
    const unread = evaluate(watch(), unknown, noRemarks, 0);
    assert.deepEqual(
      evaluate(unread.next, detail({ checks: [] }), noRemarks, 60 * 60_000).changes,
      [{ kind: "no-checks", minutes: 60 }],
    );
  });

  it("never reports missing checks on a host where an empty list says nothing", () => {
    const silent = detail({ capabilities: capabilities(false), checks: [] });
    assert.isTrue(anHourLater(watch(), silent).every((kinds) => kinds.length === 0));
  });
});
