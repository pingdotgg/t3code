import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

const STARTED = "2026-10-02T12:00:00.000Z";

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  checks: null,
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const detail = (overrides: Partial<Detail> = {}): Detail => ({
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
  it("reports a check result once per head commit", () => {
    const running = evaluatePullRequestWatch(watch(), detail(), noRemarks);
    assert.deepEqual(running.changes, []);
    assert.equal(running.next.headSha, "aaaaaaaaaa");

    const failing = detail({ checks: [check("lint", "failure"), check("test", "pending")] });
    const failed = evaluatePullRequestWatch(running.next, failing, noRemarks);
    assert.deepEqual(failed.changes, [
      { kind: "checks-failed", failed: [check("lint", "failure")], running: 1 },
    ]);
    assert.deepEqual(evaluatePullRequestWatch(failed.next, failing, noRemarks).changes, []);

    // The final result follows once the rest finish, so a second failure is not lost.
    const finished = detail({ checks: [check("lint", "failure"), check("test", "failure")] });
    const final = evaluatePullRequestWatch(failed.next, finished, noRemarks);
    assert.deepEqual(final.changes, [
      {
        kind: "checks-failed",
        failed: [check("lint", "failure"), check("test", "failure")],
        running: 0,
      },
    ]);
    // Rerunning one of them is not news until the rerun finishes, and then it is.
    const rerunning = detail({ checks: [check("lint", "failure"), check("test", "pending")] });
    const quiet = evaluatePullRequestWatch(final.next, rerunning, noRemarks);
    assert.deepEqual(quiet.changes, []);
    assert.equal(
      evaluatePullRequestWatch(quiet.next, finished, noRemarks).changes[0]?.kind,
      "checks-failed",
    );

    // A push that fails the same way before a pass ever sees it pending is still news.
    const pushed = detail({ ...failing, headSha: "bbbbbbbbbb" });
    assert.equal(
      evaluatePullRequestWatch(failed.next, pushed, noRemarks).changes[0]?.kind,
      "checks-failed",
    );

    // A rerun that passes on the same head is news too.
    const rerun = detail({ checks: [check("lint", "success"), check("test", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(failed.next, rerun, noRemarks).changes, [
      { kind: "checks-passed", count: 2, neutral: [] },
    ]);
  });

  it("reports a check that needs someone's action", () => {
    const blocked = detail({
      checks: [check("lint", "success"), check("deploy", "action-required")],
    });
    assert.deepEqual(evaluatePullRequestWatch(watch(), blocked, noRemarks).changes, [
      { kind: "checks-failed", failed: [check("deploy", "action-required")], running: 0 },
    ]);
  });

  it("reports a new run as news on hosts that send no head commit", () => {
    const passing = detail({ headSha: undefined, checks: [check("ci", "success")] });
    const passed = evaluatePullRequestWatch(watch({ wakes: 3 }), passing, noRemarks);
    assert.equal(passed.changes[0]?.kind, "checks-passed");
    const rerun = evaluatePullRequestWatch(
      passed.next,
      detail({ headSha: undefined, checks: [check("ci", "pending")] }),
      noRemarks,
    );
    assert.deepEqual(rerun.changes, []);
    assert.equal(rerun.next.wakes, 0);
    assert.equal(
      evaluatePullRequestWatch(rerun.next, passing, noRemarks).changes[0]?.kind,
      "checks-passed",
    );
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

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    // GitHub answers "unknown" while it recomputes after a push; that is not a resolution.
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
});

describe("pullRequestWatchMessage", () => {
  it("tells the agent what changed and marks failures for the timeline", () => {
    const report = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("lint", "failure")] }),
      [remark("reviewer", "2026-10-02T12:10:00Z", "<!-- bot -->Needs a test.")],
    );
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: report.next.headSha,
      report,
    });
    assert.include(message.text, "- Checks failed on aaaaaaa:\n  - lint https://ci.example/lint");
    assert.include(message.text, '  - reviewer on src/index.ts: "Needs a test."');
    assert.include(message.text, "unwatch_pull_request");
    assert.deepEqual(message.notification, {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: "#12: checks failed, new comments",
    });
  });
});
