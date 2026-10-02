import { assert, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceCaseId,
  ProjectId,
  ThreadId,
  type CollaborativeAcceptanceRecord,
  type PullRequestRef,
} from "@t3tools/contracts";

import { selectCurrentAcceptanceCaseForPullRequest } from "./caseLookup.ts";

const pullRequest: PullRequestRef = {
  projectId: ProjectId.make("project-1"),
  repository: "owner/repository",
  number: 42,
};

const record = (input: {
  readonly caseId: string;
  readonly lifecycle: "awaiting-review" | "accepted";
  readonly parentThreadId?: string;
  readonly headSha?: string;
  readonly repository?: string;
}): CollaborativeAcceptanceRecord =>
  ({
    revision: 0,
    case: {
      caseId: CollaborativeAcceptanceCaseId.make(input.caseId),
      assignmentId: `assignment-${input.caseId}`,
      parentThreadId: ThreadId.make(input.parentThreadId ?? "thread-1"),
      pullRequest: {
        ...pullRequest,
        repository: input.repository ?? pullRequest.repository,
      },
      contractRevision: "contract-1",
      currentCandidate: {
        candidateId: `candidate-${input.caseId}`,
        reviewEpoch: 1,
        headSha: input.headSha ?? "head-1",
        contractRevision: "contract-1",
        reviewWorkflow: { identity: "workflow", version: "1" },
        createdAt: "2026-09-20T00:00:00.000Z",
      },
      criteria: [],
      policy: {
        automation: "off",
        reviewTrigger: "manual",
        reviewWorkflow: { identity: "workflow", version: "1" },
        commentPolicy: "blocking-only",
        budgets: {
          exchanges: 0,
          modelSpendCents: 0,
          retries: 0,
          disputeRounds: 0,
          executionDurationSeconds: 0,
          waitingDeadlineSeconds: 0,
        },
      },
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
    candidates: [],
    evidence: [],
    assessments: [],
    exchanges: [],
    projection: {
      caseId: CollaborativeAcceptanceCaseId.make(input.caseId),
      candidateId: `candidate-${input.caseId}`,
      headSha: input.headSha ?? "head-1",
      executionPhase: "monitoring",
      collaborationStatus: "none",
      acceptanceLifecycle: input.lifecycle,
      readiness: "blocked",
      reasons: [],
      staleAssessmentIds: [],
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
  }) as unknown as CollaborativeAcceptanceRecord;

it("selects the sole active case over historical terminal history", () => {
  const result = selectCurrentAcceptanceCaseForPullRequest({
    records: [
      record({ caseId: "case-old", lifecycle: "accepted" }),
      record({ caseId: "case-current", lifecycle: "awaiting-review", headSha: "head-2" }),
    ],
    pullRequest,
  });

  assert.deepStrictEqual(result, {
    _tag: "selected",
    record: expectRecord("case-current"),
  });
});

it("returns not-found when only terminal or differently associated cases exist", () => {
  const result = selectCurrentAcceptanceCaseForPullRequest({
    records: [
      record({ caseId: "case-old", lifecycle: "accepted" }),
      record({ caseId: "case-other-pr", lifecycle: "awaiting-review", repository: "owner/other" }),
      record({
        caseId: "case-other-thread",
        lifecycle: "awaiting-review",
        parentThreadId: "thread-2",
        repository: "owner/other",
      }),
    ],
    pullRequest,
  });

  assert.deepStrictEqual(result, { _tag: "not-found" });
});

it("fails closed when more than one active case matches the durable identity", () => {
  const result = selectCurrentAcceptanceCaseForPullRequest({
    records: [
      record({ caseId: "case-b", lifecycle: "awaiting-review" }),
      record({ caseId: "case-a", lifecycle: "awaiting-review" }),
    ],
    pullRequest,
  });

  assert.deepStrictEqual(result, {
    _tag: "ambiguous",
    caseIds: ["case-a", "case-b"].map((caseId) => CollaborativeAcceptanceCaseId.make(caseId)),
  });
});

it("keeps the case identity stable across head movement but rejects PR reassociation", () => {
  const result = selectCurrentAcceptanceCaseForPullRequest({
    records: [
      record({ caseId: "case-head-moved", lifecycle: "awaiting-review", headSha: "head-3" }),
      record({
        caseId: "case-reassociated",
        lifecycle: "awaiting-review",
        repository: "owner/reassociated",
      }),
    ],
    pullRequest,
  });

  assert.equal(result._tag, "selected");
  if (result._tag === "selected") {
    assert.equal(result.record.case.caseId, CollaborativeAcceptanceCaseId.make("case-head-moved"));
    assert.equal(result.record.case.currentCandidate.headSha, "head-3");
  }
});

it("resolves the unique active case by PR across parent threads, ignoring historical accepted cases", () => {
  const result = selectCurrentAcceptanceCaseForPullRequest({
    records: [
      record({
        caseId: "case-historical-creator",
        lifecycle: "accepted",
        parentThreadId: "archived-recovered-creator",
      }),
      record({
        caseId: "case-active-associated-owner",
        lifecycle: "awaiting-review",
        parentThreadId: "active-manual-owner",
      }),
    ],
    pullRequest,
  });

  assert.deepStrictEqual(result, {
    _tag: "selected",
    record: record({
      caseId: "case-active-associated-owner",
      lifecycle: "awaiting-review",
      parentThreadId: "active-manual-owner",
    }),
  });
});

it("fails closed when active cases for one PR have different parent threads", () => {
  const result = selectCurrentAcceptanceCaseForPullRequest({
    records: [
      record({ caseId: "case-b", lifecycle: "awaiting-review", parentThreadId: "thread-b" }),
      record({ caseId: "case-a", lifecycle: "awaiting-review", parentThreadId: "thread-a" }),
    ],
    pullRequest,
  });

  assert.deepStrictEqual(result, {
    _tag: "ambiguous",
    caseIds: ["case-a", "case-b"].map((caseId) => CollaborativeAcceptanceCaseId.make(caseId)),
  });
});

function expectRecord(caseId: string): CollaborativeAcceptanceRecord {
  return record({ caseId, lifecycle: "awaiting-review", headSha: "head-2" });
}
