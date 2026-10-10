import type {
  PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { ThreadPullRequestWatch as ThreadPullRequestWatchSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  PULL_REQUEST_WATCH_MISSING_GRACE_MS,
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  awaitsRequiredChecks,
  evaluatePullRequestWatch,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

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
  headSeenAt: null,
  missingChecks: [],
  behind: false,
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
  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(evaluatePullRequestWatch(lint.next, first, noRemarks).changes, []);

    // A different job failing later is news of its own.
    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    // A rerun leaves the list while it runs, so failing again is reported again.
    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks);
    assert.equal(evaluatePullRequestWatch(rerun.next, second, noRemarks).changes.length, 1);

    // A push reports its failures, even ones that failed between two passes.
    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(evaluatePullRequestWatch(test.next, pushed, noRemarks).changes.length, 1);
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

    // Where nothing is marked required, every check has to pass.
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

    // The gate job was created and finished between two passes, so it was never seen pending.
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

    // Seen pending first, the gate is reported once it passes, as before.
    const pending = detail({
      checks: [required("Tests", "success"), required("Smoke Tests Gate", "pending")],
    });
    const waiting = evaluatePullRequestWatch(first.next, pending, noRemarks);
    assert.deepEqual(waiting.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(waiting.next, gated, noRemarks).changes, [
      { kind: "checks-passed", count: 2, required: true },
    ]);
  });

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
    // Without a viewer, the author is taken to be the agent.
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

describe("evaluatePullRequestWatch missing required checks", () => {
  const SEEN = "2026-10-02T12:00:00.000Z";
  const seenMs = Date.parse(SEEN);
  const required = (name: string, status: PullRequestCheck["status"]) => ({
    ...check(name, status),
    required: true,
  });
  const watching = (overrides: Partial<ThreadPullRequestWatch> = {}) =>
    watch({ headSha: "aaaaaaaaaa", headSeenAt: SEEN, ...overrides });
  const expecting = (checks: ReadonlyArray<PullRequestCheck>, expectedChecks = ["lint", "e2e"]) =>
    detail({ checks, expectedChecks });
  const lintOnly = [required("lint", "success")];
  const after = (ms: number) => seenMs + ms;

  it("waits out the grace period before calling a required check missing", () => {
    const early = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, {
      now: after(PULL_REQUEST_WATCH_MISSING_GRACE_MS - 1),
    });
    assert.deepEqual(early.changes, []);
    assert.deepEqual(early.next.missingChecks, []);

    const late = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, {
      now: after(PULL_REQUEST_WATCH_MISSING_GRACE_MS),
    });
    assert.deepEqual(late.changes, [{ kind: "checks-missing", missing: ["e2e"] }]);
    assert.deepEqual(late.next.missingChecks, ["e2e"]);
  });

  it("reports a missing check once per commit", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const first = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, { now });
    const again = evaluatePullRequestWatch(first.next, expecting(lintOnly), noRemarks, {
      now: now + 60_000,
    });
    assert.deepEqual(again.changes, []);
  });

  it("reports only the checks that are newly missing", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const first = evaluatePullRequestWatch(
      watching(),
      expecting(lintOnly, ["lint", "e2e"]),
      noRemarks,
      { now },
    );
    const more = evaluatePullRequestWatch(
      first.next,
      expecting(lintOnly, ["lint", "e2e", "docs"]),
      noRemarks,
      { now },
    );
    assert.deepEqual(more.changes, [{ kind: "checks-missing", missing: ["docs"] }]);
    assert.deepEqual(more.next.missingChecks, ["e2e", "docs"]);
  });

  it("does not say the required checks passed while one has not reported", () => {
    const grace = { now: after(1_000) };
    const held = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, grace);
    assert.deepEqual(held.changes, []);
    assert.isFalse(held.next.passed);

    const reported = [required("lint", "success"), required("e2e", "success")];
    const done = evaluatePullRequestWatch(held.next, expecting(reported), noRemarks, grace);
    assert.deepEqual(done.changes, [{ kind: "checks-passed", count: 2, required: true }]);
  });

  it("says a missing check once per commit, even if it reports and then vanishes again", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const missing = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, { now });
    const reported = [required("lint", "success"), required("e2e", "pending")];
    const cleared = evaluatePullRequestWatch(missing.next, expecting(reported), noRemarks, { now });
    assert.deepEqual(cleared.next.missingChecks, ["e2e"]);
    const gone = evaluatePullRequestWatch(cleared.next, expecting(lintOnly), noRemarks, { now });
    assert.deepEqual(gone.changes, []);
    assert.deepEqual(gone.next.missingChecks, ["e2e"]);
  });

  it("does not say passed while a check it called missing is still absent and nothing says what is required", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const missing = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, { now });
    // The host cannot say what is required this time: no expectedChecks.
    const unclear = detail({ checks: lintOnly });
    const blind = evaluatePullRequestWatch(missing.next, unclear, noRemarks, { now });
    assert.deepEqual(blind.changes, []);
    assert.isFalse(blind.next.passed);
    assert.deepEqual(blind.next.missingChecks, ["e2e"]);
    // Once it is visibly reported, nothing holds "passed" back.
    const reported = [required("lint", "success"), required("e2e", "success")];
    const done = evaluatePullRequestWatch(blind.next, detail({ checks: reported }), noRemarks, {
      now,
    });
    assert.deepEqual(done.changes, [{ kind: "checks-passed", count: 2, required: true }]);
  });

  it("counts a check qualified by its workflow as reported", () => {
    const qualified = [required("lint", "success"), required("CI / e2e", "success")];
    const result = evaluatePullRequestWatch(watching(), expecting(qualified), noRemarks, {
      now: after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2),
    });
    assert.deepEqual(result.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(result.next.missingChecks, []);
  });

  it("restarts the grace period on a push and forgets the old commit's missing checks", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const missing = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, { now });
    const pushed = evaluatePullRequestWatch(
      missing.next,
      detail({ headSha: "bbbbbbbbbb", checks: lintOnly, expectedChecks: ["lint", "e2e"] }),
      noRemarks,
      { now },
    );
    assert.deepEqual(pushed.changes, []);
    assert.deepEqual(pushed.next.missingChecks, []);
    assert.equal(pushed.next.headSeenAt, DateTime.formatIso(DateTime.makeUnsafe(now)));
  });

  it("starts the grace period when a watch saved without a head time first sees one", () => {
    const old = watching({ headSeenAt: null });
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const first = evaluatePullRequestWatch(old, expecting(lintOnly), noRemarks, { now });
    assert.deepEqual(first.changes, []);
    assert.equal(first.next.headSeenAt, DateTime.formatIso(DateTime.makeUnsafe(now)));
  });

  it("stays quiet when the host cannot say which checks are required", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const unknown = detail({ checks: lintOnly });
    assert.deepEqual(evaluatePullRequestWatch(watching(), unknown, noRemarks, { now }).changes, [
      { kind: "checks-passed", count: 1, required: true },
    ]);
  });

  it("stays quiet when no check reported at all, which may be a failed read", () => {
    const now = after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2);
    const result = evaluatePullRequestWatch(watching(), expecting([]), noRemarks, { now });
    assert.deepEqual(result.changes, []);
  });

  it("reports nothing missing without a clock", () => {
    const result = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks);
    assert.deepEqual(result.changes, []);
  });

  it("does not spend the comment wake limit on a missing check", () => {
    const tired = watching({ wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(tired, expecting(lintOnly), noRemarks, {
      now: after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2),
    });
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("loads a watch saved before missing-check tracking", () => {
    const decoded = Schema.decodeUnknownSync(ThreadPullRequestWatchSchema)({
      startedAt: STARTED,
      headSha: null,
      failedChecks: [],
      passed: false,
      remarksThrough: STARTED,
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    });
    assert.isNull(decoded.headSeenAt);
    assert.deepEqual(decoded.missingChecks, []);
  });

  it("tells the agent which required checks never reported", () => {
    const report = evaluatePullRequestWatch(watching(), expecting(lintOnly), noRemarks, {
      now: after(PULL_REQUEST_WATCH_MISSING_GRACE_MS * 2),
    });
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: report.next.headSha,
      report,
    });
    assert.include(
      message.text,
      "- Required checks have not reported on aaaaaaa after 10 minutes:\n  - e2e",
    );
    assert.deepEqual(message.notification, {
      source: { kind: "monitor" },
      outcome: "failed",
      summary: "#12: required checks missing",
    });
  });
});

describe("evaluatePullRequestWatch behind base", () => {
  const behindBlocked = (overrides: Partial<Detail> = {}) =>
    detail({ baseComparison: "behind", behindBlocksMerge: true, ...overrides });

  it("reports a branch the base has left behind, once, until it catches up", () => {
    const first = evaluatePullRequestWatch(watch(), behindBlocked(), noRemarks);
    assert.deepEqual(first.changes, [{ kind: "behind" }]);
    assert.isTrue(first.next.behind);
    assert.deepEqual(evaluatePullRequestWatch(first.next, behindBlocked(), noRemarks).changes, []);

    const caughtUp = evaluatePullRequestWatch(
      first.next,
      detail({ baseComparison: "up-to-date", behindBlocksMerge: false }),
      noRemarks,
    );
    assert.deepEqual(caughtUp.changes, []);
    assert.isFalse(caughtUp.next.behind);
    // Falling behind again is news again.
    assert.deepEqual(evaluatePullRequestWatch(caughtUp.next, behindBlocked(), noRemarks).changes, [
      { kind: "behind" },
    ]);
  });

  it("reports it again after a push that is still behind", () => {
    const first = evaluatePullRequestWatch(
      watch({ headSha: "aaaaaaaaaa" }),
      behindBlocked(),
      noRemarks,
    );
    const pushed = evaluatePullRequestWatch(
      first.next,
      behindBlocked({ headSha: "bbbbbbbbbb" }),
      noRemarks,
    );
    assert.deepEqual(pushed.changes, [{ kind: "behind" }]);
  });

  it("ignores a branch that is behind without the host saying that blocks the merge", () => {
    const quiet = detail({ baseComparison: "behind", behindBlocksMerge: false });
    const result = evaluatePullRequestWatch(watch(), quiet, noRemarks);
    assert.deepEqual(result.changes, []);
    assert.isFalse(result.next.behind);
  });

  it("falls back to the comparison on a host that cannot say what blocks the merge", () => {
    const result = evaluatePullRequestWatch(
      watch(),
      detail({ baseComparison: "behind" }),
      noRemarks,
    );
    assert.deepEqual(result.changes, [{ kind: "behind" }]);
  });

  it("keeps its state when the host could not compare", () => {
    const first = evaluatePullRequestWatch(watch(), behindBlocked(), noRemarks);
    for (const unclear of [
      detail({ baseComparison: "unknown" }),
      detail(),
      // GitHub has not computed the merge state: the host cannot tell, whatever the comparison says.
      detail({ baseComparison: "up-to-date", behindBlocksMerge: null }),
      detail({ baseComparison: "behind", behindBlocksMerge: null }),
    ]) {
      const result = evaluatePullRequestWatch(first.next, unclear, noRemarks);
      assert.deepEqual(result.changes, []);
      assert.isTrue(result.next.behind);
    }
  });

  it("counts a behind-only wake toward the wake limit, as a comment-only one does", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(tired, behindBlocked(), noRemarks);
    assert.isTrue(result.exhausted);
    assert.equal(result.next.wakes, PULL_REQUEST_WATCH_WAKE_LIMIT);
  });

  it("does not count a wake that also brings a check result", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(
      tired,
      behindBlocked({ checks: [check("lint", "failure")] }),
      noRemarks,
    );
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("tells the agent to update the branch, and marks it as news rather than a failure", () => {
    const report = evaluatePullRequestWatch(watch(), behindBlocked(), noRemarks);
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: report.next.headSha,
      report,
    });
    assert.include(message.text, "- The branch is behind main and needs to catch up with it.");
    assert.deepEqual(message.notification, {
      source: { kind: "monitor" },
      outcome: "updated",
      summary: "#12: behind base",
    });
  });

  it("loads a watch saved before behind-base tracking", () => {
    const decoded = Schema.decodeUnknownSync(ThreadPullRequestWatchSchema)({
      startedAt: STARTED,
      headSha: null,
      failedChecks: [],
      passed: false,
      remarksThrough: STARTED,
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    });
    assert.isFalse(decoded.behind);
  });
});

describe("awaitsRequiredChecks", () => {
  const lintOnly = [check("lint", "success")];
  const expecting = (checks: ReadonlyArray<PullRequestCheck>, expectedChecks?: Array<string>) =>
    detail({ checks, ...(expectedChecks === undefined ? {} : { expectedChecks }) });

  it("waits for a required check that has not reported and has not been called missing", () => {
    assert.isTrue(awaitsRequiredChecks(watch(), expecting(lintOnly, ["lint", "e2e"])));
  });

  it("stops waiting once the agent was told, so an absent check does not force a read every pass", () => {
    const told = watch({ missingChecks: ["e2e"] });
    assert.isFalse(awaitsRequiredChecks(told, expecting(lintOnly, ["lint", "e2e"])));
    // A second absent check the agent was not told about still counts.
    assert.isTrue(awaitsRequiredChecks(told, expecting(lintOnly, ["lint", "e2e", "docs"])));
  });

  it("does not wait when every required check reported, or nothing says what is required", () => {
    assert.isFalse(awaitsRequiredChecks(watch(), expecting(lintOnly, ["lint"])));
    assert.isFalse(awaitsRequiredChecks(watch(), expecting(lintOnly)));
    assert.isFalse(awaitsRequiredChecks(watch(), expecting([], ["lint"])));
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
