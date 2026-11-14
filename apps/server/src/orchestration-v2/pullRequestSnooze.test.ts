import type {
  PullRequestSnoozeTrigger,
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
  trigger: PullRequestSnoozeTrigger,
  before: ReadonlyArray<ThreadPullRequestLink>,
  after: ReadonlyArray<ThreadPullRequestLink>,
) => {
  const thread = { snoozedUntil: CAP, snoozeUntilPullRequest: trigger };
  const next = wakePullRequestSnooze(before, thread, after, NOW);
  return (
    next !== thread && DateTime.toEpochMillis(next.snoozedUntil!) === DateTime.toEpochMillis(NOW)
  );
};

describe("wakePullRequestSnooze", () => {
  const unchanged = link({});
  const approved = link({ reviewDecision: "approved" });
  const checksPassed = link({ checksState: "passing" });
  const conflicting = link({ mergeability: "conflicting" });

  it.each([
    ["update", unchanged, approved, true],
    ["update", unchanged, conflicting, true],
    ["update", unchanged, checksPassed, true],
    ["update", unchanged, link({ title: "Renamed" }), false],
    ["review", unchanged, approved, true],
    ["review", unchanged, link({ reviewDecision: "changes-requested" }), true],
    ["review", approved, approved, false],
    ["review", unchanged, checksPassed, false],
    ["checks", unchanged, link({ checksState: "failing" }), true],
    ["checks", link({ checksState: "passing" }), link({ checksState: "failing" }), false],
    ["checks", unchanged, approved, false],
    ["conflict", unchanged, conflicting, true],
    ["conflict", conflicting, conflicting, false],
    ["conflict", unchanged, approved, false],
  ] as const)("%s: wakes on the change? %#", (trigger, before, after, expected) => {
    assert.equal(woke(trigger, [before], [after]), expected);
  });

  it("leaves finished checks to an agent watching the pull request unless asked for checks", () => {
    const watchedPassed = link({ checksState: "passing" }, { watch });
    assert.isFalse(woke("update", [unchanged], [watchedPassed]));
    assert.isTrue(woke("checks", [unchanged], [watchedPassed]));
  });

  it("wakes when no open pull request is left, whatever the trigger", () => {
    assert.isTrue(woke("conflict", [unchanged], [link({ state: "merged" })]));
    assert.isTrue(woke("review", [unchanged], [link({ state: "closed" })]));
    assert.isTrue(woke("checks", [unchanged], []));
    const other = link({}, { number: 13, url: "https://github.com/acme/app/pull/13" });
    assert.isFalse(woke("review", [unchanged, other], [link({ state: "merged" }), other]));
  });

  it("takes a pull request's first read as its baseline", () => {
    assert.isFalse(woke("review", [link(null)], [approved]));
    assert.isFalse(woke("review", [], [approved]));
  });

  it("leaves time snoozes and ended snoozes alone", () => {
    const timed = { snoozedUntil: CAP, snoozeUntilPullRequest: null };
    assert.strictEqual(wakePullRequestSnooze([unchanged], timed, [], NOW), timed);
    const ended = { snoozedUntil: NOW, snoozeUntilPullRequest: "update" as const };
    assert.strictEqual(wakePullRequestSnooze([unchanged], ended, [], NOW), ended);
  });
});
