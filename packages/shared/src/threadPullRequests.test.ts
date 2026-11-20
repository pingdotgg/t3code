import { describe, expect, it } from "@effect/vitest";
import type { ThreadPullRequestSnapshot } from "@t3tools/contracts";

import { pullRequestSyncWakesSnooze } from "./threadPullRequests.ts";

const snoozedAt = "2026-10-02T12:00:00.000Z";
const snapshot = (fields: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Waiting on maintainers",
  headBranch: "feature",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-10-01T09:00:00.000Z",
  syncedAt: snoozedAt,
  mergeability: "mergeable",
  ...fields,
});

describe("pullRequestSyncWakesSnooze", () => {
  it.each([
    [
      "a comment after the snooze",
      snapshot(),
      snapshot({ updatedAt: "2026-10-02T12:05:00Z" }),
      true,
    ],
    ["checks moving with no update", snapshot(), snapshot({ checksState: "passing" }), false],
    ["activity from before the snooze", null, snapshot(), false],
    ["a new conflict", snapshot(), snapshot({ mergeability: "conflicting" }), true],
    [
      "a conflict already there on the first read",
      null,
      snapshot({ mergeability: "conflicting" }),
      false,
    ],
    [
      "a merge from before the snooze on the first read",
      null,
      snapshot({ state: "merged" }),
      false,
    ],
    [
      "a merge after the snooze on the first read",
      null,
      snapshot({ state: "merged", updatedAt: "2026-10-02T12:05:00Z" }),
      true,
    ],
    ["a close", snapshot(), snapshot({ state: "closed" }), true],
  ] as const)("%s", (_name, previous, next, wakes) => {
    expect(pullRequestSyncWakesSnooze({ previous, next, snoozedAtMs: Date.parse(snoozedAt) })).toBe(
      wakes,
    );
  });
});
