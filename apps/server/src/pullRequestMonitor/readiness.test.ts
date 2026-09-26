import { describe, expect, it } from "@effect/vitest";
import type { PullRequestMonitorSnapshot } from "@t3tools/contracts";

import { computeReadiness } from "./readiness.ts";

function snapshot(overrides: Partial<PullRequestMonitorSnapshot> = {}): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 12,
    state: "open",
    isDraft: false,
    headSha: "abc123",
    baseBranch: "main",
    headBranch: "feat",
    mergeability: "mergeable",
    behindBaseBy: 0,
    titleExcerpt: "Add monitor",
    url: "https://github.com/acme/app/pull/12",
    fetchedAt: "2026-08-11T00:00:00.000Z",
    sourceRevision: "rev-1",
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: true,
      baseComparisonKnown: true,
    },
    requiredCheckCoverage: {
      expected: ["ci"],
      observed: [{ name: "ci", status: "success", headSha: "abc123" }],
      completeness: "complete",
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [
      {
        id: "c1",
        name: "ci",
        status: "success",
        headSha: "abc123",
        url: null,
        description: null,
      },
    ],
    ...overrides,
  };
}

describe("computeReadiness", () => {
  it("labels ready-to-merge only when required checks are known", () => {
    const ready = computeReadiness(snapshot());
    expect(ready).toEqual({
      ready: true,
      label: "ready-to-merge",
      blockers: [],
    });

    const unknownRequired = computeReadiness(
      snapshot({
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: true,
          checksComplete: true,
          requiredChecksKnown: false,
          baseComparisonKnown: true,
        },
        requiredCheckCoverage: {
          expected: ["ci"],
          observed: [{ name: "ci", status: "success", headSha: "abc123" }],
          completeness: "unknown",
        },
      }),
    );
    expect(unknownRequired.label).toBe("blocked");
    expect(unknownRequired.ready).toBe(false);
    expect(unknownRequired.blockers).toContainEqual(
      expect.objectContaining({ kind: "required-check-coverage-unknown" }),
    );
  });

  it("blocks on changes-requested and unresolved threads", () => {
    const result = computeReadiness(
      snapshot({
        reviews: [
          {
            id: "r1",
            author: { login: "rev", kind: "user" },
            state: "changes-requested",
            submittedAt: "2026-08-11T00:00:00.000Z",
            commitSha: "abc123",
            bodyExcerpt: "fix",
          },
        ],
        reviewThreads: [
          {
            id: "t1",
            author: { login: "rev", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T01:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "nit",
          },
        ],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.label).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      "changes-requested",
      "unresolved-thread",
    ]);
  });

  it("blocks on cancelled checks: a cancelled run never proved success", () => {
    const result = computeReadiness(
      snapshot({
        checkRuns: [
          {
            id: "c1",
            name: "build",
            status: "cancelled",
            headSha: "abc123",
            url: null,
            description: null,
          },
        ],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(["check-cancelled"]);
  });

  it("blocks on durable feedback, delivery, and remediation state", () => {
    const result = computeReadiness(snapshot(), {
      openCount: 2,
      verifyingCount: 1,
      needsHumanCount: 1,
      pendingDeliveryCount: 3,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      "feedback-delivery-pending",
      "feedback-needs-human",
      "feedback-open",
      "feedback-unverified",
    ]);
  });

  it("downgrades to no-known-blockers when review evidence is incomplete", () => {
    const result = computeReadiness(
      snapshot({
        completeness: {
          reviewsComplete: false,
          reviewThreadsComplete: true,
          issueCommentsComplete: true,
          checksComplete: true,
          requiredChecksKnown: true,
          baseComparisonKnown: true,
        },
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.label).toBe("blocked");
    expect(result.blockers).toContainEqual({
      kind: "evidence-incomplete",
      detail: "reviews",
    });
  });

  it("treats base distance and unavailable comparison evidence as informational", () => {
    const result = computeReadiness(
      snapshot({
        behindBaseBy: null,
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: true,
          checksComplete: true,
          requiredChecksKnown: true,
          baseComparisonKnown: false,
        },
      }),
    );
    expect(result).toEqual({ ready: true, label: "ready-to-merge", blockers: [] });

    const behind = computeReadiness(snapshot({ behindBaseBy: 3 }));
    expect(behind).toEqual({ ready: true, label: "ready-to-merge", blockers: [] });
  });

  it("fails closed when pagination is incomplete even if loaded findings are clear", () => {
    const result = computeReadiness(
      snapshot({
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: false,
          checksComplete: true,
          requiredChecksKnown: true,
          baseComparisonKnown: true,
        },
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual({
      kind: "evidence-incomplete",
      detail: "issue-comments",
    });
  });

  it("fails closed for unknown mergeability and incomplete checks", () => {
    const result = computeReadiness(
      snapshot({
        mergeability: "unknown",
        completeness: {
          reviewsComplete: true,
          reviewThreadsComplete: true,
          issueCommentsComplete: true,
          checksComplete: false,
          requiredChecksKnown: true,
          baseComparisonKnown: true,
        },
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual([
      "mergeability",
      "evidence-incomplete",
    ]);
  });

  it("blocks on merge conflicts", () => {
    const result = computeReadiness(snapshot({ mergeability: "conflicting" }));
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ kind: "mergeability", detail: "conflicting" }]);
  });

  it("fails closed for missing, unknown, and extra required-check identities", () => {
    for (const requiredCheckCoverage of [
      {
        expected: ["ci", "build"],
        observed: [{ name: "ci", status: "success" as const, headSha: "abc123" }],
        completeness: "missing" as const,
      },
      {
        expected: ["ci"],
        observed: [{ name: "ci", status: "success" as const, headSha: "abc123" }],
        completeness: "unknown" as const,
      },
      {
        expected: ["ci"],
        observed: [
          { name: "ci", status: "success" as const, headSha: "abc123" },
          { name: "extra", status: "success" as const, headSha: "abc123" },
        ],
        completeness: "extra" as const,
      },
    ]) {
      const result = computeReadiness(snapshot({ requiredCheckCoverage }));
      expect(result.ready).toBe(false);
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ kind: "required-check-coverage-unknown" }),
      );
    }
  });
});
