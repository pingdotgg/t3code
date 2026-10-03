import { assert, it } from "@effect/vitest";
import {
  CollaborativeAcceptanceAssessmentId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceEvidenceId,
  CollaborativeAcceptanceExecutionId,
  CollaborativeAcceptanceExchangeId,
  ProjectId,
  ThreadId,
  type CollaborativeAcceptanceRecord,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { advanceAcceptanceCandidate } from "../../collaborativeAcceptance/domain.ts";
import { CollaborativeAcceptanceRepository } from "../Services/CollaborativeAcceptance.ts";
import { CollaborativeAcceptanceRepositoryLive } from "./CollaborativeAcceptance.ts";

const now = "2026-09-19T00:00:00.000Z";

const record = (suffix = "repository"): CollaborativeAcceptanceRecord => {
  const caseId = CollaborativeAcceptanceCaseId.make(`case-${suffix}`);
  const candidateId = CollaborativeAcceptanceCandidateId.make(`candidate-${suffix}`);
  const evidenceId = CollaborativeAcceptanceEvidenceId.make(`evidence-${suffix}`);
  const assessmentId = CollaborativeAcceptanceAssessmentId.make(`assessment-${suffix}`);
  const exchangeId = CollaborativeAcceptanceExchangeId.make(`exchange-${suffix}`);
  const candidate = {
    candidateId,
    reviewEpoch: 1,
    headSha: "sha-repository",
    contractRevision: "contract-1",
    reviewWorkflow: { identity: "review-v1", version: "1" },
    createdAt: now,
  } as const;
  const acceptanceCase = {
    caseId,
    assignmentId: `assignment-${suffix}`,
    parentThreadId: ThreadId.make(`parent-${suffix}`),
    pullRequest: {
      projectId: ProjectId.make(`project-${suffix}`),
      repository: "owner/repository",
      number: 42,
    },
    contractRevision: "contract-1",
    currentCandidate: candidate,
    criteria: [
      {
        criterionId: "criterion",
        description: "Criterion",
        required: true,
        evidenceKinds: ["criterion"],
      },
    ],
    policy: {
      automation: "bounded",
      reviewTrigger: "first-candidate",
      reviewWorkflow: { identity: "review-v1", version: "1" },
      commentPolicy: "blocking-only",
      budgets: {
        exchanges: 1,
        modelSpendCents: 10,
        retries: 1,
        disputeRounds: 1,
        executionDurationSeconds: 60,
        waitingDeadlineSeconds: 60,
      },
    },
    createdAt: now,
    updatedAt: now,
  } as const;
  return {
    revision: 0,
    case: acceptanceCase,
    candidates: [candidate],
    evidence: [
      {
        evidenceId,
        caseId,
        candidateId,
        headSha: candidate.headSha,
        kind: "criterion",
        criterionId: "criterion",
        sourceId: "tests",
        summary: "passed",
        complete: true,
        current: true,
        observedAt: now,
      },
    ],
    providerEvidence: {
      caseId,
      candidateId,
      headSha: candidate.headSha,
      sourceId: "pull-request-monitor",
      sourceRevision: "monitor-1",
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
      requiredCheckCoverage: { expected: [], observed: [], completeness: "complete" },
      unresolvedActionableFindings: 0,
      unresolvedReviewThreads: 0,
      observedAt: now,
    },
    assessments: [
      {
        assessmentId,
        caseId,
        role: "child-implementer",
        kind: "attestation",
        outcome: "pass",
        candidateId,
        reviewEpoch: candidate.reviewEpoch,
        headSha: candidate.headSha,
        contractRevision: candidate.contractRevision,
        reviewWorkflow: candidate.reviewWorkflow,
        criteriaEvidenceIds: [evidenceId],
        createdAt: now,
      },
    ],
    exchanges: [
      {
        exchangeId,
        caseId,
        executionId: CollaborativeAcceptanceExecutionId.make(`execution-${suffix}`),
        status: "reserved",
        retryCount: 0,
        reservedAt: now,
        startedAt: null,
        outcomeRecordedAt: null,
        completedAt: null,
        cancelledAt: null,
        modelSpendCents: 0,
      },
    ],
    obligations: [
      {
        obligationId: `obligation-${suffix}`,
        requestId: `request-${suffix}`,
        caseId,
        ownerThreadId: ThreadId.make(`child-${suffix}`),
        status: "open",
        createdAt: now,
        resolvedAt: null,
      },
    ],
    projection: {
      caseId,
      candidateId,
      headSha: candidate.headSha,
      executionPhase: "verifying",
      collaborationStatus: "parent-assessment-pending",
      acceptanceLifecycle: "awaiting-review",
      readiness: "blocked",
      reasons: ["parent-assessment-missing"],
      staleAssessmentIds: [],
      updatedAt: now,
    },
  };
};

const repositoryLayer = it.layer(
  CollaborativeAcceptanceRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

repositoryLayer("Collaborative acceptance repository", (it) => {
  it.effect("round-trips the aggregate and projection", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record();

      yield* repository.save({ record: input, expectedRevision: null });
      const result = yield* repository.getByCaseId({ caseId: input.case.caseId });

      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;
      assert.deepStrictEqual(result.value, input);
    }),
  );

  it.effect("lists cases by assignment without replacing execution state", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record("list");

      yield* repository.save({ record: input, expectedRevision: null });
      const result = yield* repository.listByAssignmentId({
        assignmentId: input.case.assignmentId,
      });

      assert.deepStrictEqual(
        result.map(({ projection }) => projection.acceptanceLifecycle),
        ["awaiting-review"],
      );
    }),
  );

  it.effect("lists cases by parent thread for targeted pull-request lookup", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record("parent-thread");
      const other = record("parent-thread-other");

      yield* repository.save({ record: input, expectedRevision: null });
      yield* repository.save({ record: other, expectedRevision: null });

      const result = yield* repository.listByParentThreadId({
        parentThreadId: input.case.parentThreadId,
      });

      assert.deepStrictEqual(
        result.map(({ case: acceptanceCase }) => acceptanceCase.caseId),
        [input.case.caseId],
      );
    }),
  );

  it.effect("lists cases by exact project and pull-request identity across parent threads", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const matching = record("pr-lookup-match");
      const samePrOtherParent = {
        ...record("pr-lookup-other-parent"),
        case: {
          ...record("pr-lookup-other-parent").case,
          pullRequest: matching.case.pullRequest,
        },
      };
      const otherPr = record("pr-lookup-other-pr");

      yield* repository.save({ record: matching, expectedRevision: null });
      yield* repository.save({ record: samePrOtherParent, expectedRevision: null });
      yield* repository.save({ record: otherPr, expectedRevision: null });

      const result = yield* repository.listByPullRequest(matching.case.pullRequest);

      assert.deepStrictEqual(
        result.map(({ case: acceptanceCase }) => acceptanceCase.caseId),
        [matching.case.caseId, samePrOtherParent.case.caseId],
      );
    }),
  );

  it.effect("lists all immutable case records for PR lookup", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const first = record("lookup-first");
      const second = record("lookup-second");

      yield* repository.save({ record: first, expectedRevision: null });
      yield* repository.save({ record: second, expectedRevision: null });

      const result = yield* repository.listAll();

      const caseIds = new Set(result.map(({ case: acceptanceCase }) => acceptanceCase.caseId));
      assert.isTrue(caseIds.has(first.case.caseId));
      assert.isTrue(caseIds.has(second.case.caseId));
    }),
  );

  it.effect("keeps prior candidates immutable when a new review epoch is saved", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record("immutable");
      yield* repository.save({ record: input, expectedRevision: null });
      const nextCandidate = {
        ...input.case.currentCandidate,
        candidateId: CollaborativeAcceptanceCandidateId.make("candidate-immutable-b"),
        reviewEpoch: 2,
        headSha: "sha-immutable-b",
        createdAt: "2026-09-19T00:01:00.000Z",
      };
      const advanced = advanceAcceptanceCandidate(input.case, nextCandidate);
      assert.isTrue(advanced.ok);
      if (!advanced.ok) return;

      const advancedRecord = {
        ...input,
        case: advanced.acceptanceCase,
        candidates: [...input.candidates, nextCandidate],
        projection: {
          ...input.projection,
          candidateId: nextCandidate.candidateId,
          headSha: nextCandidate.headSha,
          updatedAt: nextCandidate.createdAt,
        },
      };
      const saved = yield* repository.save({ record: advancedRecord, expectedRevision: 0 });
      assert.strictEqual(saved.revision, 1);

      const result = yield* repository.getByCaseId({ caseId: input.case.caseId });
      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;
      assert.deepStrictEqual(
        result.value.candidates.map((candidate) => candidate.headSha),
        ["sha-repository", "sha-immutable-b"],
      );
    }),
  );

  it.effect("fences concurrent reservations so an exchange budget cannot be overspent", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const seed = record("concurrent");
      const base = { ...seed, exchanges: [] };
      yield* repository.save({ record: base, expectedRevision: null });
      const exchanges = seed.exchanges;
      const first = { ...base, exchanges: [exchanges[0]!] };
      const second = {
        ...base,
        exchanges: [
          {
            ...exchanges[0]!,
            exchangeId: CollaborativeAcceptanceExchangeId.make("exchange-concurrent-2"),
          },
        ],
      };

      const outcomes = yield* Effect.all(
        [
          repository.save({ record: first, expectedRevision: 0 }).pipe(Effect.exit),
          repository.save({ record: second, expectedRevision: 0 }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );

      assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
      assert.strictEqual(outcomes.filter(Exit.isFailure).length, 1);
      const result = yield* repository.getByCaseId({ caseId: base.case.caseId });
      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;
      assert.strictEqual(result.value.revision, 1);
      assert.strictEqual(result.value.exchanges.length, 1);
    }),
  );

  it.effect("rejects concurrent starts and stale candidate writes", () =>
    Effect.gen(function* () {
      const repository = yield* CollaborativeAcceptanceRepository;
      const input = record("starts");
      yield* repository.save({ record: input, expectedRevision: null });

      const started = {
        ...input,
        exchanges: [{ ...input.exchanges[0]!, status: "committed" as const, startedAt: now }],
      };
      const alternateStart = {
        ...started,
        projection: { ...started.projection, reasons: ["alternate-start"] },
      };
      const outcomes = yield* Effect.all(
        [
          repository.save({ record: started, expectedRevision: 0 }).pipe(Effect.exit),
          repository.save({ record: alternateStart, expectedRevision: 0 }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
      assert.strictEqual(outcomes.filter(Exit.isFailure).length, 1);

      const nextCandidate = {
        ...input.case.currentCandidate,
        candidateId: CollaborativeAcceptanceCandidateId.make("candidate-stale-check"),
        reviewEpoch: 2,
        headSha: "sha-stale-check",
        createdAt: "2026-09-19T00:01:00.000Z",
      };
      const advanced = advanceAcceptanceCandidate(input.case, nextCandidate);
      assert.isTrue(advanced.ok);
      if (!advanced.ok) return;
      const latest = yield* repository.getByCaseId({ caseId: input.case.caseId });
      assert.isTrue(Option.isSome(latest));
      if (Option.isNone(latest)) return;
      const staleWrite = {
        ...input,
        case: advanced.acceptanceCase,
        candidates: [...input.candidates, nextCandidate],
        projection: {
          ...input.projection,
          candidateId: nextCandidate.candidateId,
          headSha: nextCandidate.headSha,
        },
      };
      const stale = yield* repository
        .save({
          record: staleWrite,
          expectedRevision: 0,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stale));
      assert.strictEqual(latest.value.revision, 1);
    }),
  );
});
