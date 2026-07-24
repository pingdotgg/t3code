import { assert, describe, it } from "@effect/vitest";

import type { PullRequestMonitorSnapshot } from "../sourceControl/gitHubPullRequestMonitor.ts";
import { computeReadiness } from "./readiness.ts";

const snapshot = (
  overrides: Partial<PullRequestMonitorSnapshot> = {},
): PullRequestMonitorSnapshot => ({
  state: "open",
  draft: false,
  headSha: "head-2",
  baseRefName: "main",
  mergeability: "mergeable",
  behindBaseBy: null,
  requiredChecksKnown: true,
  reviews: [],
  reviewThreads: [],
  issueComments: [],
  checkRuns: [
    {
      id: "run-1",
      name: "CI",
      status: "completed",
      conclusion: "success",
      startedAt: null,
      headSha: "head-2",
    },
  ],
  ...overrides,
});

describe("pull request monitor readiness", () => {
  it("keeps blocking on a changes-requested review even after a push", () => {
    // A stale change request must hold the gate until the bot re-reviews;
    // otherwise every fix push would flash green before re-review lands.
    const result = computeReadiness(
      snapshot({
        reviews: [
          {
            id: "review-1",
            author: { login: "review-bot", type: "app" },
            state: "changes-requested",
            submittedAt: "2026-01-01T00:00:00Z",
            commitSha: "head-1",
          },
        ],
      }),
    );
    assert.strictEqual(result.ready, false);
    assert.deepStrictEqual(result.blockers, [
      { kind: "changes-requested", reviewer: "review-bot" },
    ]);
  });

  it("blocks on a human changes-requested review", () => {
    const result = computeReadiness(
      snapshot({
        reviews: [
          {
            id: "review-human",
            author: { login: "human-reviewer", type: "user" },
            state: "changes-requested",
            submittedAt: "2026-01-01T00:00:00Z",
            commitSha: "head-2",
          },
        ],
      }),
    );
    assert.deepStrictEqual(result.blockers, [
      { kind: "changes-requested", reviewer: "human-reviewer" },
    ]);
  });

  it("ignores stale approvals after a push", () => {
    const result = computeReadiness(
      snapshot({
        reviews: [
          {
            id: "review-1",
            author: { login: "review-bot", type: "app" },
            state: "approved",
            submittedAt: "2026-01-01T00:00:00Z",
            commitSha: "head-1",
          },
        ],
      }),
    );
    // A stale approval neither blocks nor counts as fresh green evidence.
    assert.strictEqual(result.ready, true);
  });

  it("does not report ready when no check runs exist", () => {
    const result = computeReadiness(snapshot({ checkRuns: [] }));
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.label, "no-known-blockers");
    assert.deepStrictEqual(result.blockers, [{ kind: "checks-missing" }]);
  });

  it("returns terminal blockers for merged and closed snapshots", () => {
    for (const state of ["merged", "closed"] as const) {
      const result = computeReadiness(snapshot({ state }));
      assert.strictEqual(result.ready, false);
      assert.deepStrictEqual(result.blockers[0], { kind: "terminal", state });
    }
  });

  it("uses the honest fallback label when required-check evidence is unavailable", () => {
    const result = computeReadiness(snapshot({ requiredChecksKnown: false }));
    assert.strictEqual(result.ready, true);
    assert.strictEqual(result.label, "no-known-blockers");
  });
});
