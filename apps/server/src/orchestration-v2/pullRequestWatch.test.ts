import {
  type PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch as evaluate,
  pullRequestWatchEndMessage,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

// These cases read the head once or at one moment, so the no-checks notice never comes due.
// Without required checks given, the base branch was read and requires none.
const evaluatePullRequestWatch = (
  watch: Parameters<typeof evaluate>[0],
  detail: Parameters<typeof evaluate>[1],
  remarks: Parameters<typeof evaluate>[2],
  requiredChecks: Parameters<typeof evaluate>[3] = [],
) => evaluate(watch, detail, remarks, requiredChecks, 0);

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
/** The base branch was read and requires no checks. */
const NONE_REQUIRED: ReadonlyArray<string> = [];

describe("evaluatePullRequestWatch", () => {
  it.each(["pending", "success"] as const)(
    "reports a required rebase once with %s CI",
    (status) => {
      const blocked = detail({
        mergeability: "unknown",
        rebaseRequired: true,
        checks: [check("test", status)],
      });
      const first = evaluatePullRequestWatch(watch(), blocked, noRemarks);
      assert.include(
        first.changes.map((change) => change.kind),
        "needs-rebase",
      );
      assert.deepEqual(evaluatePullRequestWatch(first.next, blocked, noRemarks).changes, []);
      const unknown = evaluatePullRequestWatch(
        first.next,
        { ...blocked, rebaseRequired: undefined },
        noRemarks,
      );
      assert.deepEqual(evaluatePullRequestWatch(unknown.next, blocked, noRemarks).changes, []);
      const clean = evaluatePullRequestWatch(
        first.next,
        { ...blocked, rebaseRequired: false },
        noRemarks,
      );
      assert.deepEqual(evaluatePullRequestWatch(clean.next, blocked, noRemarks).changes, [
        { kind: "needs-rebase" },
      ]);
      assert.include(
        evaluatePullRequestWatch(
          first.next,
          { ...blocked, headSha: "bbbbbbbbbb" },
          noRemarks,
        ).changes.map((change) => change.kind),
        "needs-rebase",
      );
    },
  );

  it.each([false, true])("baselines already-passed checks (required: %s)", (required) => {
    const green = detail({ checks: [{ ...check("test", "success"), required }] });
    const baseline = evaluatePullRequestWatch(watch({ awaitingBaseline: "all" }), green, noRemarks);
    assert.deepEqual(baseline.changes, []);
    assert.equal(baseline.next.headSha, green.headSha);
    assert.isTrue(baseline.next.passed);
    assert.deepEqual(baseline.next.passedChecks, ["test"]);
    assert.isFalse(baseline.exhausted);
    assert.deepEqual(evaluatePullRequestWatch(baseline.next, green, noRemarks).changes, []);

    const pending = evaluatePullRequestWatch(
      baseline.next,
      detail({ checks: [{ ...check("test", "pending"), required }] }),
      noRemarks,
    );
    assert.deepEqual(pending.changes, []);
    const failed = evaluatePullRequestWatch(
      pending.next,
      detail({ checks: [{ ...check("test", "failure"), required }] }),
      noRemarks,
    );
    assert.equal(failed.changes[0]?.kind, "checks-failed");
    const passed = evaluatePullRequestWatch(failed.next, green, noRemarks);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 1, required }]);
    assert.deepEqual(
      evaluatePullRequestWatch(passed.next, { ...green, headSha: "bbbbbbbbbb" }, noRemarks).changes,
      [{ kind: "checks-passed", count: 1, required }],
    );
  });

  it("baselines existing failures and conflicts, then reports new ones", () => {
    const broken = detail({
      checks: [check("lint", "failure"), check("test", "pending")],
      mergeability: "conflicting",
      rebaseRequired: true,
    });
    const baseline = evaluatePullRequestWatch(
      watch({ awaitingBaseline: "all" }),
      broken,
      noRemarks,
    );
    assert.deepEqual(baseline.changes, []);
    assert.deepEqual(baseline.next.failedChecks, ["lint"]);
    assert.isFalse(baseline.next.passed);
    assert.isTrue(baseline.next.conflicting);
    assert.isTrue(baseline.next.rebaseRequired);
    assert.deepEqual(evaluatePullRequestWatch(baseline.next, broken, noRemarks).changes, []);

    const failed = evaluatePullRequestWatch(
      baseline.next,
      { ...broken, checks: [check("lint", "failure"), check("test", "failure")] },
      noRemarks,
    );
    assert.deepEqual(failed.changes, [
      { kind: "checks-failed", failed: [check("test", "failure")] },
    ]);
    const clean = evaluatePullRequestWatch(
      failed.next,
      detail({ rebaseRequired: false }),
      noRemarks,
    );
    assert.deepEqual(clean.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(clean.next, broken, noRemarks).changes, [
      { kind: "checks-failed", failed: [check("lint", "failure")] },
      { kind: "conflicting" },
      { kind: "needs-rebase" },
    ]);
  });

  it("baselines checks already awaiting approval", () => {
    const gated = detail({ checks: [{ ...check("CI", "action-required"), url: run(1) }] });
    const baseline = evaluatePullRequestWatch(watch({ awaitingBaseline: "all" }), gated, noRemarks);
    assert.deepEqual(baseline.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(baseline.next, gated, noRemarks).changes, []);
  });

  it("reports remarks after the watch started while baselining checks and conflicts", () => {
    const green = detail({
      checks: [check("test", "success")],
      mergeability: "conflicting",
    });
    const comments = [
      remark("reviewer", "2026-10-02T11:00:00Z"),
      remark("reviewer", "2026-10-02T12:06:00Z"),
    ];
    const baseline = evaluatePullRequestWatch(watch({ awaitingBaseline: "all" }), green, comments);
    assert.deepEqual(baseline.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.isTrue(baseline.next.passed);
    assert.isTrue(baseline.next.conflicting);
    assert.equal(baseline.next.wakes, 1);
    assert.deepEqual(evaluatePullRequestWatch(baseline.next, green, comments).changes, []);
  });

  it("reports a failure once the head SHA appears after a baseline without one", () => {
    const waiting = evaluatePullRequestWatch(
      watch({ awaitingBaseline: "all" }),
      detail({ headSha: undefined, checks: [check("test", "pending")] }),
      noRemarks,
    );
    assert.deepEqual(waiting.changes, []);
    const failed = evaluatePullRequestWatch(
      waiting.next,
      detail({ checks: [check("test", "failure")] }),
      noRemarks,
    );
    assert.deepEqual(failed.changes, [
      { kind: "checks-failed", failed: [check("test", "failure")] },
    ]);
  });

  it("keeps a baseline taken without a head SHA once the SHA appears", () => {
    const green = detail({ checks: [check("test", "success")] });
    const baseline = evaluatePullRequestWatch(
      watch({ awaitingBaseline: "all" }),
      { ...green, headSha: undefined },
      noRemarks,
    );
    const known = evaluatePullRequestWatch(baseline.next, green, noRemarks);
    assert.deepEqual(known.changes, []);
    assert.equal(known.next.headSha, green.headSha);
    const unknown = evaluatePullRequestWatch(
      known.next,
      { ...green, headSha: undefined },
      noRemarks,
    );
    assert.equal(unknown.next.headSha, green.headSha);
    assert.deepEqual(
      evaluatePullRequestWatch(unknown.next, { ...green, headSha: "bbbbbbbbbb" }, noRemarks)
        .changes,
      [{ kind: "checks-passed", count: 1, required: false }],
    );
  });

  it.each(["success", "failure"] as const)(
    "reports %s on checks that appear after a first read without any",
    (status) => {
      const empty = evaluatePullRequestWatch(
        watch({ awaitingBaseline: "all" }),
        detail({ checks: [] }),
        noRemarks,
      );
      assert.deepEqual(empty.changes, []);
      assert.isUndefined(empty.next.awaitingBaseline);
      assert.isTrue(empty.next.checksPending);
      assert.deepEqual(
        evaluatePullRequestWatch(empty.next, detail({ checks: [check("test", status)] }), noRemarks)
          .changes,
        status === "success"
          ? [{ kind: "checks-passed", count: 1, required: false }]
          : [{ kind: "checks-failed", failed: [check("test", "failure")] }],
      );
    },
  );

  it("keeps the check baseline through a read whose approval lookup failed", () => {
    const bot = check("bot", "success");
    const unavailable = { ...check("Workflow approval status", "pending"), placeholder: true };
    const partial = evaluatePullRequestWatch(
      watch({ awaitingBaseline: "all" }),
      detail({ checks: [bot, unavailable] }),
      noRemarks,
    );
    assert.deepEqual(partial.changes, []);
    assert.equal(partial.next.awaitingBaseline, "checks");
    const approval = { ...check("CI", "action-required"), url: run(1) };
    for (const checks of [[bot], [bot, approval]]) {
      assert.deepEqual(
        evaluatePullRequestWatch(partial.next, detail({ checks }), noRemarks).changes,
        [],
      );
    }
  });

  it("reports pending advisory checks finishing after a required-check baseline", () => {
    const initial = detail({
      checks: [{ ...check("test", "success"), required: true }, check("bot", "pending")],
    });
    const baseline = evaluatePullRequestWatch(
      watch({ awaitingBaseline: "all" }),
      initial,
      noRemarks,
    );
    assert.deepEqual(baseline.changes, []);
    const settled = evaluatePullRequestWatch(
      baseline.next,
      {
        ...initial,
        checks: [initial.checks[0]!, check("bot", "success")],
      },
      noRemarks,
    );
    assert.deepEqual(settled.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(
      evaluatePullRequestWatch(
        settled.next,
        {
          ...initial,
          checks: [initial.checks[0]!, check("bot", "success")],
        },
        noRemarks,
      ).changes,
      [],
    );
  });

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
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks, NONE_REQUIRED);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(
      evaluatePullRequestWatch(lint.next, first, noRemarks, NONE_REQUIRED).changes,
      [],
    );

    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks, NONE_REQUIRED);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    // A rerun leaves the list while it runs, so failing again is reported again.
    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks, NONE_REQUIRED);
    assert.equal(
      evaluatePullRequestWatch(rerun.next, second, noRemarks, NONE_REQUIRED).changes.length,
      1,
    );

    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(
      evaluatePullRequestWatch(test.next, pushed, noRemarks, NONE_REQUIRED).changes.length,
      1,
    );

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
    const passed = evaluatePullRequestWatch(watch(), green, noRemarks, ["test", "lint"]);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(
      evaluatePullRequestWatch(passed.next, green, noRemarks, ["test", "lint"]).changes,
      [],
    );

    // A base-branch rule that passes still waits for a workflow awaiting approval.
    const approval = { ...check("Deploy", "action-required"), url: run(3) };
    const held = detail({ checks: [required("test", "success"), approval] });
    assert.deepEqual(evaluatePullRequestWatch(watch(), held, noRemarks, ["test"]).changes, [
      { kind: "checks-awaiting-approval", checks: [approval] },
    ]);

    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(
      evaluatePullRequestWatch(watch(), plain, noRemarks, NONE_REQUIRED).changes,
      [],
    );
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
    const first = evaluatePullRequestWatch(watch(), early, noRemarks, NONE_REQUIRED);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    const done = detail({
      checks: [required("test", "success"), check("e2e", "success")],
    });
    const final = evaluatePullRequestWatch(first.next, done, noRemarks, NONE_REQUIRED);
    assert.deepEqual(
      final.changes.map((change) => change.kind),
      ["checks-passed"],
    );
    assert.deepEqual(
      evaluatePullRequestWatch(final.next, done, noRemarks, NONE_REQUIRED).changes,
      [],
    );
    // A later advisory job running and passing is not more news.
    const botPending = detail({ checks: [...done.checks, check("bot", "pending")] });
    const churn = evaluatePullRequestWatch(final.next, botPending, noRemarks, NONE_REQUIRED);
    assert.deepEqual(churn.changes, []);
    const botDone = detail({ checks: [...done.checks, check("bot", "success")] });
    assert.deepEqual(
      evaluatePullRequestWatch(churn.next, botDone, noRemarks, NONE_REQUIRED).changes,
      [],
    );

    // A pending check that turns required on the next read still finishes with one wake.
    const promoted = detail({
      checks: [required("test", "success"), required("e2e", "success")],
    });
    const gated = evaluatePullRequestWatch(first.next, promoted, noRemarks, NONE_REQUIRED);
    assert.deepEqual(gated.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(
      evaluatePullRequestWatch(gated.next, promoted, noRemarks, NONE_REQUIRED).changes,
      [],
    );

    // Nothing else was pending when the required ones passed, so nothing more is owed.
    const green = evaluatePullRequestWatch(watch(), done, noRemarks, NONE_REQUIRED);
    assert.deepEqual(green.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(
      evaluatePullRequestWatch(green.next, botDone, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  it("reports an owed non-required failure once after the required notice", () => {
    const required = { ...check("test", "success"), required: true };
    const early = detail({ checks: [required, check("e2e", "pending")] });
    const first = evaluatePullRequestWatch(watch(), early, noRemarks, NONE_REQUIRED);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    const failed = detail({ checks: [required, check("e2e", "failure")] });
    const failure = evaluatePullRequestWatch(first.next, failed, noRemarks, NONE_REQUIRED);
    assert.deepEqual(failure.changes, [
      { kind: "checks-failed", failed: [check("e2e", "failure")] },
    ]);
    const repeated = evaluatePullRequestWatch(failure.next, failed, noRemarks, NONE_REQUIRED);
    assert.deepEqual(repeated.changes, []);
    const recovered = detail({ checks: [required, check("e2e", "success")] });
    const final = evaluatePullRequestWatch(repeated.next, recovered, noRemarks, NONE_REQUIRED);
    assert.deepEqual(final.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(
      evaluatePullRequestWatch(final.next, recovered, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  it("clears old-head owed checks when a new head is pushed", () => {
    const required = { ...check("test", "success"), required: true };
    const early = detail({ checks: [required, check("e2e", "pending")] });
    const first = evaluatePullRequestWatch(watch(), early, noRemarks, NONE_REQUIRED);
    assert.deepEqual(first.next.owedChecks, ["e2e"]);
    const unreadHead = detail({ headSha: "bbbbbbbbbb", checks: [] });
    const unread = evaluatePullRequestWatch(first.next, unreadHead, noRemarks, NONE_REQUIRED);
    assert.deepEqual(unread.changes, []);
    assert.deepEqual(unread.next.owedChecks, []);
    const pushed = detail({ ...unreadHead, checks: [required] });
    const newHead = evaluatePullRequestWatch(unread.next, pushed, noRemarks, NONE_REQUIRED);
    assert.deepEqual(newHead.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(newHead.next.owedChecks, []);
    const lateResult = detail({ ...pushed, checks: [required, check("e2e", "success")] });
    const final = evaluatePullRequestWatch(newHead.next, lateResult, noRemarks, NONE_REQUIRED);
    assert.deepEqual(final.changes, []);
    assert.deepEqual(
      evaluatePullRequestWatch(final.next, lateResult, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  // regression: #16208 PR watches burned GitHub's rate limit and gave up
  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("test", "success")] }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(
      evaluatePullRequestWatch(first.next, both, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  describe("with the base branch's required check list", () => {
    const MIGRATIONS = "Validate migrations on PostgreSQL 18";
    const AGGREGATE = "Lint, type-check, test and build";
    const requiredChecks = [MIGRATIONS, AGGREGATE];
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const complete = detail({
      checks: [
        required(MIGRATIONS, "success"),
        required(AGGREGATE, "success"),
        check("Affected workspace checks", "success"),
        check("CodeRabbit", "pending"),
      ],
    });

    it("waits for a required check no run has created yet, then reports passed once", () => {
      // The aggregate job starts only after the workspace jobs, so it is absent at first.
      const early = evaluatePullRequestWatch(
        watch(),
        detail({
          checks: [required(MIGRATIONS, "success"), check("Affected workspace checks", "pending")],
        }),
        noRemarks,
        requiredChecks,
      );
      assert.deepEqual(early.changes, []);
      assert.isFalse(early.next.passed);

      const ready = evaluatePullRequestWatch(early.next, complete, noRemarks, requiredChecks);
      assert.deepEqual(ready.changes, [{ kind: "checks-passed", count: 2, required: true }]);
      assert.deepEqual(
        evaluatePullRequestWatch(ready.next, complete, noRemarks, requiredChecks).changes,
        [],
      );
    });

    it("never reports passed while the list is unknown, and keeps what it already told", () => {
      const unknown = evaluatePullRequestWatch(watch(), complete, noRemarks, "unknown");
      assert.deepEqual(unknown.changes, []);
      assert.isFalse(unknown.next.passed);

      const ready = evaluatePullRequestWatch(unknown.next, complete, noRemarks, requiredChecks);
      assert.equal(ready.changes.length, 1);
      // An unreadable list later neither takes the news back nor tells it twice.
      const blind = evaluatePullRequestWatch(ready.next, complete, noRemarks, "unknown");
      assert.deepEqual(blind.changes, []);
      assert.isTrue(blind.next.passed);
      assert.deepEqual(
        evaluatePullRequestWatch(blind.next, complete, noRemarks, requiredChecks).changes,
        [],
      );

      // A host that cannot list required checks never reports passed from the flags it has, but
      // comments and conflicts still wake.
      const conflicted = evaluatePullRequestWatch(
        watch(),
        detail({ ...complete, mergeability: "conflicting" }),
        [remark("reviewer", "2026-10-02T12:06:00Z")],
        "unknown",
      );
      assert.deepEqual(
        conflicted.changes.map((change) => change.kind),
        ["remarks", "conflicting"],
      );

      // A failure is still news while the list cannot be read.
      const failed = detail({
        checks: [required(MIGRATIONS, "success"), required(AGGREGATE, "failure")],
      });
      assert.deepEqual(evaluatePullRequestWatch(watch(), failed, noRemarks, "unknown").changes, [
        { kind: "checks-failed", failed: [required(AGGREGATE, "failure")] },
      ]);
    });

    it("reports a failure, then passed once its rerun recovers, and again for a new head", () => {
      const failing = detail({
        checks: [required(MIGRATIONS, "success"), required(AGGREGATE, "failure")],
      });
      const failed = evaluatePullRequestWatch(watch(), failing, noRemarks, requiredChecks);
      assert.equal(failed.changes[0]?.kind, "checks-failed");

      const rerun = detail({
        checks: [required(MIGRATIONS, "success"), required(AGGREGATE, "pending")],
      });
      const running = evaluatePullRequestWatch(failed.next, rerun, noRemarks, requiredChecks);
      assert.deepEqual(running.changes, []);
      const recovered = evaluatePullRequestWatch(running.next, complete, noRemarks, requiredChecks);
      assert.deepEqual(recovered.changes, [{ kind: "checks-passed", count: 2, required: true }]);

      const pushed = detail({ ...complete, headSha: "bbbbbbbbbb" });
      assert.deepEqual(
        evaluatePullRequestWatch(recovered.next, pushed, noRemarks, requiredChecks).changes,
        [{ kind: "checks-passed", count: 2, required: true }],
      );
    });

    it("matches a required job GitHub qualifies with its workflow", () => {
      const qualified = detail({
        checks: [check(`CI / ${AGGREGATE}`, "success"), check(MIGRATIONS, "success")],
      });
      assert.deepEqual(
        evaluatePullRequestWatch(watch(), qualified, noRemarks, requiredChecks).changes,
        [{ kind: "checks-passed", count: 2, required: true }],
      );
    });

    it("needs every check to pass where the branch requires none", () => {
      const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
      const waiting = evaluatePullRequestWatch(watch(), plain, noRemarks, []);
      assert.deepEqual(waiting.changes, []);
      const green = detail({ checks: [check("test", "success"), check("bot", "success")] });
      assert.deepEqual(evaluatePullRequestWatch(waiting.next, green, noRemarks, []).changes, [
        { kind: "checks-passed", count: 2, required: false },
      ]);
    });
  });

  it("does not wake a watch saved before passed checks were recorded", () => {
    const green = detail({ checks: [{ ...check("test", "success"), required: true }] });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true });
    const saved = evaluatePullRequestWatch(told, green, noRemarks, ["test"]);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later pass when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluatePullRequestWatch(watch(), detail(), null, NONE_REQUIRED);
    assert.deepEqual(partial.changes, []);
    assert.equal(
      evaluatePullRequestWatch(partial.next, detail(), comments, NONE_REQUIRED).changes[0]?.kind,
      "remarks",
    );
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluatePullRequestWatch(watch(), detail(), [first], NONE_REQUIRED);
    const again = evaluatePullRequestWatch(reported.next, detail(), [first, late], NONE_REQUIRED);
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
    assert.deepEqual(
      evaluatePullRequestWatch(watching, detail(), [old], NONE_REQUIRED).changes,
      [],
    );
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluatePullRequestWatch(watching, detail(), [edited], NONE_REQUIRED);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.deepEqual(report.next.remarkIds, [old.id]);
    assert.isTrue(report.exhausted);
    assert.deepEqual(
      evaluatePullRequestWatch(report.next, detail(), [edited], NONE_REQUIRED).changes,
      [],
    );
    const late = { ...edited, id: "late" };
    assert.deepEqual(
      evaluatePullRequestWatch(report.next, detail(), [edited, late], NONE_REQUIRED).changes,
      [{ kind: "remarks", remarks: [late] }],
    );
  });

  it("wakes once per edit of a remark seen at the watermark, never for the agent's own", () => {
    const seen = remark("ci-bot", "2026-10-10T19:52:40.000Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarksThrough: seen.createdAt,
      remarkIds: [seen.id],
      wakes: 2,
    });
    assert.deepEqual(
      evaluatePullRequestWatch(watching, detail(), [seen], NONE_REQUIRED).changes,
      [],
    );
    const edited = { ...seen, editedAt: "2026-10-10T20:04:50.000Z" };
    const first = evaluatePullRequestWatch(watching, detail(), [edited], NONE_REQUIRED);
    assert.deepEqual(first.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.strictEqual(first.next.remarksThrough, edited.editedAt);
    assert.deepEqual(
      evaluatePullRequestWatch(first.next, detail(), [edited], NONE_REQUIRED).changes,
      [],
    );
    const again = { ...seen, editedAt: "2026-10-10T20:05:50.000Z" };
    const second = evaluatePullRequestWatch(first.next, detail(), [again], NONE_REQUIRED);
    assert.deepEqual(second.changes, [{ kind: "remarks", remarks: [again] }]);
    assert.deepEqual(
      evaluatePullRequestWatch(second.next, detail(), [again], NONE_REQUIRED).changes,
      [],
    );
    const own = { ...edited, author: { login: "agent-user", name: null, avatarUrl: null } };
    assert.deepEqual(
      evaluatePullRequestWatch(watching, detail(), [own], NONE_REQUIRED).changes,
      [],
    );
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluatePullRequestWatch(watch(), failed, noRemarks, NONE_REQUIRED);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluatePullRequestWatch(
      reported.next,
      detail({ checks: [] }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(unreadable.next, failed, noRemarks, NONE_REQUIRED).changes,
      [],
    );
  });

  it("wakes for the pull request's author when the agent is someone else", () => {
    const contributor = detail({ author: { login: "contributor", name: null, avatarUrl: null } });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(
      evaluatePullRequestWatch(watch(), contributor, [reply], NONE_REQUIRED).changes,
      [{ kind: "remarks", remarks: [reply] }],
    );
    // Without a viewer, the author is taken to be the agent.
    const noViewer = detail({ viewer: undefined, author: contributor.author });
    assert.deepEqual(
      evaluatePullRequestWatch(watch(), noViewer, [reply], NONE_REQUIRED).changes,
      [],
    );
  });

  it("reports remarks from others once and never the agent's own", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    const report = evaluatePullRequestWatch(watch(), detail(), comments, NONE_REQUIRED);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(
      evaluatePullRequestWatch(report.next, detail(), comments, NONE_REQUIRED).changes,
      [],
    );
  });

  it("cuts a long remark in the wake message without splitting an emoji", () => {
    const body = `${"x".repeat(196)}🚀 and more`;
    const report = evaluatePullRequestWatch(
      watch(),
      detail(),
      [remark("reviewer", "2026-10-02T12:06:00Z", body)],
      NONE_REQUIRED,
    );
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

  it.each([
    [
      "a bot's leading badge",
      '<a href="https://app.coderabbit.ai/change-stack/o/r/pull/1?cs_source=review_comment"><picture><source media="(prefers-color-scheme: dark)" srcset="https://coderabbit.ai/badge-dark.svg"><img alt="Severity > `Minor`" src="https://coderabbit.ai/badge.svg"></picture></a>\r\n\r\n_⚠️ Potential issue_ | _🟠 Major_\r\n\r\n**Guard the empty list.**',
      "_⚠️ Potential issue_ | _🟠 Major_ **Guard the empty list.**",
    ],
    [
      "tags in prose and a hidden comment",
      "<!-- state -->\n<details>\n<summary>Why</summary>\n\n<p>Guard this</p>, then <br/>retry.\n</details>",
      "Why Guard this , then retry.",
    ],
    [
      "type arguments",
      "Return Promise<void>, not Promise<A> or Vec<code>.",
      "Return Promise<void>, not Promise<A> or Vec<code>.",
    ],
    [
      "code spans and fences",
      "Replace `<div>` with ``<span>``:\n~~~html\n<p>Done</p>\n~~~\r\nor\r\n```html\r\n<b>Done</b>\r\n```",
      "Replace `<div>` with ``<span>``: ~~~html <p>Done</p> ~~~ or ```html <b>Done</b> ```",
    ],
    [
      "indented code",
      "Use this replacement:\n\n    <div>\n      <span>Ready</span>\n    </div>\n\nKeep the <b>wrapper</b>.",
      "Use this replacement: <div> <span>Ready</span> </div> Keep the wrapper .",
    ],
    ["an indented continuation of an HTML block", "<div>\n    <span>Ready</span>\n</div>", "Ready"],
  ])("quotes a remark's text without its HTML tags: %s", (_name, body, quoted) => {
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
    assert.include(text, `: "${quoted}" `);
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks, NONE_REQUIRED);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    const { headSha: _unreadHead, ...headUnread } = conflicting;
    const unread = evaluatePullRequestWatch(first.next, headUnread, noRemarks, NONE_REQUIRED);
    assert.deepEqual(unread.changes, []);
    assert.deepEqual(
      evaluatePullRequestWatch(unread.next, conflicting, noRemarks, NONE_REQUIRED).changes,
      [],
    );
    const recomputing = evaluatePullRequestWatch(
      first.next,
      detail({ mergeability: "unknown" }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(recomputing.next, conflicting, noRemarks, NONE_REQUIRED).changes,
      [],
    );
    const clean = evaluatePullRequestWatch(first.next, detail(), noRemarks, NONE_REQUIRED);
    assert.deepEqual(
      evaluatePullRequestWatch(clean.next, conflicting, noRemarks, NONE_REQUIRED).changes,
      [{ kind: "conflicting" }],
    );
    const pushed = { headSha: "bbbbbbbbbb" };
    const recomputed = evaluatePullRequestWatch(
      first.next,
      detail({ ...pushed, mergeability: "unknown" }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(
        recomputed.next,
        detail({ ...pushed, mergeability: "conflicting" }),
        noRemarks,
        NONE_REQUIRED,
      ).changes,
      [{ kind: "conflicting" }],
    );
  });

  it("reports each merge queue removal once while the head checks stay green", () => {
    const green = detail({ checks: [check("test", "success")] });
    const watching = evaluatePullRequestWatch(watch(), green, noRemarks).next;
    const removed = (id: string, removedAt: string) =>
      detail({ ...green, mergeQueueRemoval: { id, removedAt, reason: "Merge conflict" } });

    const dropped = removed("first", "2026-10-02T12:10:00Z");
    const first = evaluatePullRequestWatch(watching, dropped, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "merge-queue-removed", reason: "Merge conflict" }]);
    const wake = pullRequestWatchMessage({
      number: 1,
      url: "https://github.com/o/r/pull/1",
      baseBranch: "main",
      headSha: first.next.headSha,
      report: first,
    });
    assert.deepEqual(wake.notification, {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: "#1: removed from merge queue",
    });
    assert.deepEqual(evaluatePullRequestWatch(first.next, dropped, noRemarks).changes, []);
    // A read without queue news keeps the removal already told.
    const quiet = evaluatePullRequestWatch(first.next, green, noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(quiet.next, dropped, noRemarks).changes, []);

    const again = removed("second", "2026-10-02T12:20:00Z");
    assert.equal(evaluatePullRequestWatch(first.next, again, noRemarks).changes.length, 1);
    const before = removed("before", "2026-10-02T11:00:00Z");
    const baseline = evaluatePullRequestWatch(
      watch({ headSha: watching.headSha, passed: true, passedChecks: watching.passedChecks }),
      before,
      noRemarks,
    );
    assert.deepEqual(baseline.changes, []);
    for (const prior of [watching, baseline.next]) {
      const skewed = evaluatePullRequestWatch(
        prior,
        removed("new", "2026-10-02T11:59:58Z"),
        noRemarks,
      );
      assert.deepEqual(skewed.changes, [{ kind: "merge-queue-removed", reason: "Merge conflict" }]);
      assert.deepEqual(
        evaluatePullRequestWatch(skewed.next, removed("new", "2026-10-02T11:59:58Z"), noRemarks)
          .changes,
        [],
      );
    }
  });

  it("reports a merge queue removal stamped in the second the watch started", () => {
    const watching = watch({ startedAt: "2026-10-02T12:00:00.500Z" });
    const removed = (removedAt: string) =>
      detail({ mergeQueueRemoval: { id: "first", removedAt, reason: "CI failed" } });
    assert.deepEqual(
      evaluatePullRequestWatch(watching, removed("2026-10-02T12:00:00Z"), noRemarks).changes,
      [{ kind: "merge-queue-removed", reason: "CI failed" }],
    );
    assert.deepEqual(
      evaluatePullRequestWatch(watching, removed("2026-10-02T11:59:59Z"), noRemarks).changes,
      [],
    );
  });

  it("stays quiet when the queue lets go of a pull request by merging it", () => {
    const watching = evaluatePullRequestWatch(watch(), detail(), noRemarks).next;
    const merging = detail({
      mergeQueueRemoval: { id: "landed", removedAt: "2026-10-02T12:10:00Z", reason: "merged" },
    });
    const read = evaluatePullRequestWatch(watching, merging, noRemarks);
    assert.deepEqual(read.changes, []);
    assert.equal(read.next.mergeQueueRemovalId, "landed");
  });

  it("does not spend the comment wake limit on check results", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(
      tired,
      detail({ checks: [check("lint", "failure")] }),
      noRemarks,
      NONE_REQUIRED,
    );
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("stops after the wake limit unless the head moves", () => {
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.isTrue(evaluatePullRequestWatch(tired, detail(), comments, NONE_REQUIRED).exhausted);
    const pushed = evaluatePullRequestWatch(
      tired,
      detail({ headSha: "cccccccccc" }),
      comments,
      NONE_REQUIRED,
    );
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
      const { changes, next } = evaluate(current, read, noRemarks, NONE_REQUIRED, minute * 60_000);
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
    const fresh = watch({ awaitingBaseline: "all" });
    assert.deepEqual(anHourLater(fresh, unknown).flat(), []);
    const unread = evaluate(fresh, unknown, noRemarks, NONE_REQUIRED, 0);
    assert.deepEqual(
      evaluate(unread.next, detail({ checks: [] }), noRemarks, NONE_REQUIRED, 60 * 60_000).changes,
      [{ kind: "no-checks", minutes: 60 }],
    );
  });

  it("starts the no-checks clock while a fresh watch awaits its baseline", () => {
    assert.deepEqual(
      anHourLater(watch({ awaitingBaseline: "all" }), detail({ checks: [] })).flat(),
      ["no-checks"],
    );
  });

  it("never reports missing checks on a host where an empty list says nothing", () => {
    const silent = detail({ capabilities: capabilities(false), checks: [] });
    assert.isTrue(anHourLater(watch(), silent).every((kinds) => kinds.length === 0));
  });

  it("counts checks as pending until every one, a review bot's included, has finished", () => {
    const pending = (checks: ReadonlyArray<PullRequestCheck>, from = watch()) =>
      evaluatePullRequestWatch(from, detail({ checks }), noRemarks).next.checksPending;
    const ci = { ...check("test", "success"), required: true };
    assert.isTrue(pending([ci, check("CodeRabbit", "pending")]));
    assert.isFalse(pending([ci, check("CodeRabbit", "success")]));
    assert.isFalse(pending([ci, check("CodeRabbit", "failure")]));
    assert.isFalse(pending([ci, check("deploy", "action-required")]));
    // A failed read keeps the last answer, as does one with only an unreadable approval check.
    assert.isFalse(pending([], watch({ headSha: "aaaaaaaaaa", checksPending: false })));
    const unreadable = { ...check("approvals", "action-required"), placeholder: true };
    assert.isTrue(pending([unreadable], watch({ headSha: "aaaaaaaaaa", checksPending: true })));
  });

  it("waits a while for a new head's checks on every host", () => {
    const pushed = (checksAlwaysReport: boolean) =>
      evaluatePullRequestWatch(
        watch({ headSha: "aaaaaaaaaa", checksPending: false }),
        detail({
          headSha: "bbbbbbbbbb",
          capabilities: capabilities(checksAlwaysReport),
          checks: [],
        }),
        noRemarks,
      ).next.checksPending;
    assert.isTrue(pushed(true));
    assert.isTrue(pushed(false));

    // Once the no-checks window passes, the watch stops waiting for them.
    for (const checksAlwaysReport of [true, false]) {
      let current = watch({ headSha: "aaaaaaaaaa" });
      for (const minute of [0, 20]) {
        current = evaluate(
          current,
          detail({
            headSha: "bbbbbbbbbb",
            capabilities: capabilities(checksAlwaysReport),
            checks: [],
          }),
          noRemarks,
          NONE_REQUIRED,
          minute * 60_000,
        ).next;
      }
      assert.isFalse(current.checksPending);
    }

    // A watch with no answer waits on an empty list only while the no-checks clock runs.
    const unanswered = (checksAwaitedSince: string | null) =>
      evaluatePullRequestWatch(
        watch({ headSha: "bbbbbbbbbb", checksAwaitedSince }),
        detail({ headSha: "bbbbbbbbbb", checks: [] }),
        noRemarks,
      ).next.checksPending;
    assert.isFalse(unanswered(null));
    assert.isTrue(unanswered(STARTED));
  });
});

describe("pullRequestWatchEndMessage", () => {
  const url = "https://git.cafe/pingdotgg/t3code/pull/7";
  const end = (overrides: Partial<Parameters<typeof pullRequestWatchEndMessage>[0]["detail"]>) =>
    pullRequestWatchEndMessage({
      number: 7,
      url,
      detail: { state: "merged", baseBranch: "main", ...overrides },
    });
  const mergeCommitSha = "3b2f958603a51d8c42c4ede02eee7b8cb310b2d9";

  it("says how the pull request ended, with the merge commit and merger the host reports", () => {
    const merged = end({
      mergeCommitSha,
      mergedBy: { login: "juliusmarminge", name: null, avatarUrl: null },
    });
    assert.equal(
      merged.text,
      `Pull request #7 (${url}) was merged into main by juliusmarminge as 3b2f958, so T3 Code stopped watching it.`,
    );
    assert.deepEqual(merged.notification, {
      source: { kind: "monitor" },
      outcome: "completed",
      summary: "#7: merged, stopped watching",
    });
    // GitCafe reports a merge made on GitHub without who made it.
    assert.equal(
      end({ mergeCommitSha }).text,
      `Pull request #7 (${url}) was merged into main as 3b2f958, so T3 Code stopped watching it.`,
    );

    const closed = end({ state: "closed" });
    assert.equal(
      closed.text,
      `Pull request #7 (${url}) was closed without merging, so T3 Code stopped watching it. If it is reopened, call watch_pull_request to watch it again.`,
    );
    assert.equal(closed.notification.summary, "#7: closed, stopped watching");
  });
});
