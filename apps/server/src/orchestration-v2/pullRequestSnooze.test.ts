import type {
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { wakePullRequestSnooze } from "./pullRequestSnooze.ts";

const NOW = DateTime.makeUnsafe("2026-11-13T12:00:00.000Z");
const CAP = DateTime.makeUnsafe("2026-12-13T12:00:00.000Z");

const link = (
  snapshot: Partial<ThreadPullRequestSnapshot> | null,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  source: "manual",
  linkedAt: "2026-11-01T00:00:00.000Z",
  snapshot:
    snapshot === null
      ? null
      : {
          state: "open",
          title: "Add things",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-11-13T11:00:00.000Z",
          reviewDecision: "review-required",
          checksState: "pending",
          mergeability: "mergeable",
          ...snapshot,
        },
  stack: null,
  ...overrides,
});

const watch: ThreadPullRequestWatch = {
  startedAt: "2026-11-13T10:00:00.000Z",
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: "2026-11-13T10:00:00.000Z",
  remarkIds: [],
  conflicting: false,
  wakes: 0,
};

const woke = (
  before: ReadonlyArray<ThreadPullRequestLink>,
  after: ReadonlyArray<ThreadPullRequestLink>,
) => {
  const thread = { snoozedUntil: CAP, snoozeUntilPullRequest: true };
  return wakePullRequestSnooze(before, thread, after, NOW) !== thread;
};

describe("wakePullRequestSnooze", () => {
  const pending = link({});

  it.each([
    ["an approval", pending, link({ reviewDecision: "approved" }), true],
    ["requested changes", pending, link({ reviewDecision: "changes-requested" }), true],
    ["a new conflict", pending, link({ mergeability: "conflicting" }), true],
    ["finished checks", pending, link({ checksState: "failing" }), true],
    ["a rename", pending, link({ title: "Renamed" }), false],
    [
      "the same approval",
      link({ reviewDecision: "approved" }),
      link({ reviewDecision: "approved" }),
      false,
    ],
    [
      "checks that already finished",
      link({ checksState: "passing" }),
      link({ checksState: "failing" }),
      false,
    ],
  ] as const)("on %s: %s", (_name, before, after, expected) => {
    assert.equal(woke([before], [after]), expected);
  });

  it("leaves finished checks to an agent watching the pull request", () => {
    assert.isFalse(woke([pending], [link({ checksState: "passing" }, { watch })]));
  });

  it("wakes once no pull request is open", () => {
    assert.isTrue(woke([pending], [link({ state: "merged" })]));
    assert.isTrue(woke([pending], []));
    const other = link({}, { number: 13, url: "https://github.com/acme/app/pull/13" });
    assert.isFalse(woke([pending, other], [link({ state: "merged" }), other]));
  });

  it("wakes on a first read that already qualifies, but not for a pull request linked later", () => {
    assert.isTrue(woke([link(null)], [link({ reviewDecision: "approved" })]));
    assert.isTrue(woke([link(null)], [link({ checksState: "passing" })]));
    assert.isFalse(woke([link(null)], [pending]));
    assert.isFalse(woke([], [link({ reviewDecision: "approved" })]));
  });

  it("ends the snooze now and leaves timed snoozes alone", () => {
    const woken = wakePullRequestSnooze(
      [pending],
      { snoozedUntil: CAP, snoozeUntilPullRequest: true },
      [],
      NOW,
    );
    assert.deepEqual(woken, { snoozedUntil: NOW, snoozeUntilPullRequest: false });
    const timed = { snoozedUntil: CAP, snoozeUntilPullRequest: false };
    assert.strictEqual(wakePullRequestSnooze([pending], timed, [], NOW), timed);
  });
});
