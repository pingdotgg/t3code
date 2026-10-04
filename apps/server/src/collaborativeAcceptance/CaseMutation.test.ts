import { describe, expect, it } from "vitest";
import {
  CollaborativeAcceptanceAssessmentId,
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceEvidenceId,
  ProjectId,
  ThreadId,
  TurnId,
  type CollaborativeAcceptanceCandidateSubmission,
  type CollaborativeAcceptanceRecord,
  type CollaborationExecutionAuthority,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { makeAcceptanceCaseMutation } from "./CaseMutation.ts";
import type { CollaborativeAcceptanceRepository } from "../persistence/Services/CollaborativeAcceptance.ts";

const caseId = CollaborativeAcceptanceCaseId.make("case-1");
const candidateId = CollaborativeAcceptanceCandidateId.make("candidate-1");
const parentThreadId = ThreadId.make("parent-1");
const timestamp = "2026-09-21T12:00:00.000Z";

const authority: CollaborationExecutionAuthority = {
  executionId: "thread:child-1",
  assignmentId: "assignment-1",
  threadId: ThreadId.make("child-1"),
  generation: 1,
  dispatchId: "dispatch-1",
  turnId: TurnId.make("turn-1"),
};

const submission: CollaborativeAcceptanceCandidateSubmission = {
  caseId,
  assignmentId: "assignment-1",
  candidate: {
    candidateId,
    reviewEpoch: 1,
    headSha: "head-1",
    contractRevision: "contract-1",
    reviewWorkflow: { identity: "review", version: "1" },
    createdAt: timestamp,
  },
  pullRequest: {
    projectId: ProjectId.make("project-1"),
    repository: "owner/repo",
    number: 1,
  },
  criteria: [
    {
      criterionId: "tests",
      description: "Tests pass",
      required: true,
      evidenceKinds: ["criterion"],
    },
  ],
  policy: {
    automation: "bounded",
    reviewTrigger: "each-eligible-candidate",
    reviewWorkflow: { identity: "review", version: "1" },
    commentPolicy: "all-actionable-addressed",
    budgets: {
      exchanges: 2,
      modelSpendCents: 100,
      retries: 1,
      disputeRounds: 1,
      executionDurationSeconds: 60,
      waitingDeadlineSeconds: 60,
    },
  },
  initialEvidence: [
    {
      evidenceId: CollaborativeAcceptanceEvidenceId.make("evidence-1"),
      caseId,
      candidateId,
      headSha: "head-1",
      kind: "criterion",
      criterionId: "tests",
      sourceId: "tests",
      summary: "Tests passed",
      complete: true,
      current: true,
      observedAt: timestamp,
    },
  ],
  reviewCandidate: {
    caseId,
    candidateId,
    reviewEpoch: 1,
    headSha: "head-1",
    contractRevision: "contract-1",
    reviewWorkflow: { identity: "review", version: "1" },
    coverage: {
      required: ["tests"],
      covered: ["tests"],
      applicability: "known",
    },
    previousFindingVerification: {
      required: false,
      complete: true,
      verifiedRevisionIds: [],
      unresolvedRevisionIds: [],
    },
  },
};

const makeRepository = () => {
  let record: CollaborativeAcceptanceRecord | null = null;
  let saveCount = 0;
  const repository = {
    getByCaseId: () => Effect.succeed(Option.fromNullishOr(record)),
    save: (input: {
      readonly record: CollaborativeAcceptanceRecord;
      readonly expectedRevision: number | null;
    }) =>
      Effect.sync(() => {
        saveCount += 1;
        if (record === null) {
          expect(input.expectedRevision).toBeNull();
          record = input.record;
        } else {
          expect(input.expectedRevision).toBe(record.revision);
          record = { ...input.record, revision: record.revision + 1 };
        }
        return record;
      }),
    listByAssignmentId: () => Effect.succeed(record === null ? [] : [record]),
    listByParentThreadId: () => Effect.succeed(record === null ? [] : [record]),
    listByPullRequest: () => Effect.succeed(record === null ? [] : [record]),
    listAll: () => Effect.succeed(record === null ? [] : [record]),
  } satisfies CollaborativeAcceptanceRepository["Service"];
  return {
    repository,
    current: () => record,
    replace: (next: CollaborativeAcceptanceRecord) => {
      record = next;
    },
    saveCount: () => saveCount,
  };
};

describe("AcceptanceCaseMutation", () => {
  it("persists a submitted candidate with authority-bound provenance and a fresh projection", async () => {
    const fixture = makeRepository();
    const mutation = makeAcceptanceCaseMutation(fixture.repository, () => timestamp);

    const record = await Effect.runPromise(
      mutation.execute({
        _tag: "submit-candidate",
        caseId,
        submission,
        recipientThreadId: parentThreadId,
        senderAuthority: authority,
      }),
    );

    expect(record.case.currentCandidate.provenance).toEqual({
      assignmentId: "assignment-1",
      dispatchId: "dispatch-1",
      turnId: "turn-1",
      generation: 1,
      caseId,
      candidateId,
      headSha: "head-1",
      contractRevision: "contract-1",
      reviewWorkflow: { identity: "review", version: "1" },
    });
    expect(record.projection).toMatchObject({
      caseId,
      candidateId,
      headSha: "head-1",
      executionPhase: "verifying",
      collaborationStatus: "child-assessment-pending",
      acceptanceLifecycle: "pending",
    });
  });

  it("treats a repeated immutable candidate submission as idempotent", async () => {
    const fixture = makeRepository();
    const mutation = makeAcceptanceCaseMutation(fixture.repository, () => timestamp);
    const first = await Effect.runPromise(
      mutation.execute({
        _tag: "submit-candidate",
        caseId,
        submission,
        recipientThreadId: parentThreadId,
        senderAuthority: authority,
      }),
    );

    const second = await Effect.runPromise(
      mutation.execute({
        _tag: "submit-candidate",
        caseId,
        submission,
        recipientThreadId: parentThreadId,
        senderAuthority: authority,
      }),
    );

    expect(second).toEqual(first);
    expect(fixture.saveCount()).toBe(1);
  });

  it("owns assessment authorization, persistence, and projection updates", async () => {
    const fixture = makeRepository();
    const mutation = makeAcceptanceCaseMutation(fixture.repository, () => timestamp);
    await Effect.runPromise(
      mutation.execute({
        _tag: "submit-candidate",
        caseId,
        submission,
        recipientThreadId: parentThreadId,
        senderAuthority: authority,
      }),
    );

    const record = await Effect.runPromise(
      mutation.execute({
        _tag: "submit-assessment",
        caseId,
        authority,
        assessment: {
          assessmentId: CollaborativeAcceptanceAssessmentId.make("assessment-1"),
          caseId,
          role: "child-implementer",
          kind: "attestation",
          outcome: "pass",
          candidateId,
          reviewEpoch: 1,
          headSha: "head-1",
          contractRevision: "contract-1",
          reviewWorkflow: { identity: "review", version: "1" },
          criteriaEvidenceIds: [CollaborativeAcceptanceEvidenceId.make("evidence-1")],
          createdAt: timestamp,
        },
      }),
    );

    expect(record.revision).toBe(1);
    expect(record.assessments).toHaveLength(1);
    expect(record.projection.collaborationStatus).toBe("parent-assessment-pending");
  });

  it("rejects malformed prior review metadata without advancing the durable candidate", async () => {
    const fixture = makeRepository();
    const mutation = makeAcceptanceCaseMutation(fixture.repository, () => timestamp);
    const initial = await Effect.runPromise(
      mutation.execute({
        _tag: "submit-candidate",
        caseId,
        submission,
        recipientThreadId: parentThreadId,
        senderAuthority: authority,
      }),
    );
    fixture.replace({
      ...initial,
      case: {
        ...initial.case,
        currentCandidate: {
          ...initial.case.currentCandidate,
          reviewCandidate: undefined,
        },
      },
      candidates: initial.candidates.map((candidate) => ({
        ...candidate,
        reviewCandidate: undefined,
      })),
    });
    const nextCandidateId = CollaborativeAcceptanceCandidateId.make("candidate-2");
    const nextSubmission: CollaborativeAcceptanceCandidateSubmission = {
      ...submission,
      candidate: {
        ...submission.candidate,
        candidateId: nextCandidateId,
        reviewEpoch: 2,
        headSha: "head-2",
      },
      initialEvidence: [
        {
          ...submission.initialEvidence[0]!,
          evidenceId: CollaborativeAcceptanceEvidenceId.make("evidence-2"),
          candidateId: nextCandidateId,
          headSha: "head-2",
        },
      ],
      reviewCandidate: {
        ...submission.reviewCandidate,
        candidateId: nextCandidateId,
        reviewEpoch: 2,
        headSha: "head-2",
      },
    };

    await expect(
      Effect.runPromise(
        mutation.execute({
          _tag: "submit-candidate",
          caseId,
          submission: nextSubmission,
          recipientThreadId: parentThreadId,
          senderAuthority: authority,
        }),
      ),
    ).rejects.toMatchObject({
      message: "Candidate review metadata is unavailable or invalid.",
    });

    expect(fixture.saveCount()).toBe(1);
    expect(fixture.current()?.case.currentCandidate.candidateId).toBe(candidateId);
    expect(fixture.current()?.case.currentCandidate.reviewEpoch).toBe(1);
  });

  it("invalidates stale provider evidence before returning the typed failure", async () => {
    const fixture = makeRepository();
    const mutation = makeAcceptanceCaseMutation(fixture.repository, () => timestamp);
    await Effect.runPromise(
      mutation.execute({
        _tag: "submit-candidate",
        caseId,
        submission,
        recipientThreadId: parentThreadId,
        senderAuthority: authority,
      }),
    );

    await expect(
      Effect.runPromise(
        mutation.execute({
          _tag: "record-provider-evidence",
          caseId,
          evidence: {
            caseId,
            candidateId,
            headSha: "stale-head",
            sourceId: "github:owner/repo#1",
            sourceRevision: "snapshot-1",
            complete: true,
            pullRequestState: "open",
            isDraft: false,
            mergeability: "mergeable",
            reviewEvidenceComplete: true,
            reviewThreadEvidenceComplete: true,
            commentEvidenceComplete: true,
            checkEvidenceComplete: true,
            requiredChecksKnown: true,
            requiredChecks: [],
            unresolvedActionableFindings: 0,
            unresolvedReviewThreads: 0,
            observedAt: timestamp,
          },
        }),
      ),
    ).rejects.toMatchObject({ reason: "stale-head" });

    expect(fixture.current()).toMatchObject({
      revision: 1,
      providerEvidence: null,
      projection: {
        executionPhase: "paused",
        pauseReason: "stale-head",
      },
    });
  });
});
