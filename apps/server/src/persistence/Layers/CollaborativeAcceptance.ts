import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { CollaborativeAcceptanceRepositoryConflict, toPersistenceSqlError } from "../Errors.ts";
import {
  CollaborativeAcceptanceAssessmentDbRow,
  CollaborativeAcceptanceCandidateDbRow,
  CollaborativeAcceptanceCaseDbRow,
  CollaborativeAcceptanceEvidenceDbRow,
  CollaborativeAcceptanceExchangeDbRow,
  CollaborativeAcceptanceRepository,
  type CollaborativeAcceptanceRepositoryShape,
} from "../Services/CollaborativeAcceptance.ts";
import {
  CollaborativeAcceptanceAssessment,
  CollaborativeAcceptanceCase,
  CollaborativeAcceptanceCandidate,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceEvidence,
  CollaborativeAcceptanceExchange,
  CollaborativeAcceptanceObligation,
  CollaborativeAcceptanceProviderEvidence,
  CollaborativeAcceptanceProjection,
  CollaborativeAcceptanceRecord,
  ProjectId,
} from "@t3tools/contracts";

const caseIdInput = Schema.Struct({ caseId: CollaborativeAcceptanceCaseId });
const assignmentIdInput = Schema.Struct({ assignmentId: Schema.String });
const parentThreadIdInput = Schema.Struct({ parentThreadId: Schema.String });
const pullRequestInput = Schema.Struct({
  projectId: ProjectId,
  repository: Schema.String,
  number: Schema.Int,
});
const isCollaborativeAcceptanceRepositoryConflict = Schema.is(
  CollaborativeAcceptanceRepositoryConflict,
);

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertCase = SqlSchema.void({
    Request: Schema.Struct({
      case: CollaborativeAcceptanceCase,
      projection: CollaborativeAcceptanceProjection,
      providerEvidence: Schema.NullOr(CollaborativeAcceptanceProviderEvidence),
      obligations: Schema.Array(CollaborativeAcceptanceObligation),
      revision: Schema.Number,
    }),
    execute: ({ case: acceptanceCase, projection, providerEvidence, obligations, revision }) => sql`
      INSERT INTO collaborative_acceptance_cases (
        case_id, assignment_id, parent_thread_id, contract_revision,
        current_candidate_id, current_head_sha, case_json, projection_json,
        provider_evidence_json, obligations_json, pull_request_project_id,
        pull_request_repository, pull_request_number, revision, created_at, updated_at
      ) VALUES (
        ${acceptanceCase.caseId}, ${acceptanceCase.assignmentId}, ${acceptanceCase.parentThreadId},
        ${acceptanceCase.contractRevision}, ${acceptanceCase.currentCandidate.candidateId},
        ${acceptanceCase.currentCandidate.headSha}, ${JSON.stringify(acceptanceCase)},
        ${JSON.stringify(projection)}, ${
          providerEvidence === null ? null : JSON.stringify(providerEvidence)
        },
        ${JSON.stringify(obligations)}, ${acceptanceCase.pullRequest.projectId},
        ${acceptanceCase.pullRequest.repository}, ${acceptanceCase.pullRequest.number},
        ${revision}, ${acceptanceCase.createdAt},
        ${acceptanceCase.updatedAt}
      )
    `,
  });

  const updateCase = SqlSchema.void({
    Request: Schema.Struct({
      case: CollaborativeAcceptanceCase,
      projection: CollaborativeAcceptanceProjection,
      providerEvidence: Schema.NullOr(CollaborativeAcceptanceProviderEvidence),
      obligations: Schema.Array(CollaborativeAcceptanceObligation),
      expectedRevision: Schema.Number,
      revision: Schema.Number,
    }),
    execute: ({
      case: acceptanceCase,
      projection,
      providerEvidence,
      obligations,
      expectedRevision,
      revision,
    }) => sql`
      UPDATE collaborative_acceptance_cases
      SET
        assignment_id = ${acceptanceCase.assignmentId},
        parent_thread_id = ${acceptanceCase.parentThreadId},
        contract_revision = ${acceptanceCase.contractRevision},
        current_candidate_id = ${acceptanceCase.currentCandidate.candidateId},
        current_head_sha = ${acceptanceCase.currentCandidate.headSha},
        case_json = ${JSON.stringify(acceptanceCase)},
        projection_json = ${JSON.stringify(projection)},
        provider_evidence_json = ${
          providerEvidence === null ? null : JSON.stringify(providerEvidence)
        },
        obligations_json = ${JSON.stringify(obligations)},
        pull_request_project_id = ${acceptanceCase.pullRequest.projectId},
        pull_request_repository = ${acceptanceCase.pullRequest.repository},
        pull_request_number = ${acceptanceCase.pullRequest.number},
        revision = ${revision},
        updated_at = ${acceptanceCase.updatedAt}
      WHERE case_id = ${acceptanceCase.caseId}
        AND revision = ${expectedRevision}
    `,
  });

  const insertCandidate = SqlSchema.void({
    Request: Schema.Struct({
      caseId: CollaborativeAcceptanceCaseId,
      candidate: CollaborativeAcceptanceCandidate,
    }),
    execute: ({ caseId, candidate }) => sql`
      INSERT INTO collaborative_acceptance_candidates (
        candidate_id, case_id, review_epoch, head_sha, candidate_json, created_at
      ) VALUES (
        ${candidate.candidateId}, ${caseId}, ${candidate.reviewEpoch}, ${candidate.headSha},
        ${JSON.stringify(candidate)}, ${candidate.createdAt}
      )
      ON CONFLICT (candidate_id) DO NOTHING
    `,
  });

  const insertEvidence = SqlSchema.void({
    Request: Schema.Struct({
      evidence: CollaborativeAcceptanceEvidence,
    }),
    execute: ({ evidence }) => sql`
      INSERT INTO collaborative_acceptance_evidence (
        evidence_id, case_id, candidate_id, head_sha, kind, source_id,
        complete, current, evidence_json, observed_at
      ) VALUES (
        ${evidence.evidenceId}, ${evidence.caseId}, ${evidence.candidateId}, ${evidence.headSha},
        ${evidence.kind}, ${evidence.sourceId}, ${evidence.complete ? 1 : 0},
        ${evidence.current ? 1 : 0}, ${JSON.stringify(evidence)}, ${evidence.observedAt}
      )
      ON CONFLICT (evidence_id) DO NOTHING
    `,
  });

  const insertAssessment = SqlSchema.void({
    Request: Schema.Struct({
      assessment: CollaborativeAcceptanceAssessment,
    }),
    execute: ({ assessment }) => sql`
      INSERT INTO collaborative_acceptance_assessments (
        assessment_id, case_id, role, kind, outcome, candidate_id, review_epoch,
        head_sha, contract_revision, assessment_json, created_at
      ) VALUES (
        ${assessment.assessmentId}, ${assessment.caseId}, ${assessment.role}, ${assessment.kind},
        ${assessment.outcome}, ${assessment.candidateId}, ${assessment.reviewEpoch},
        ${assessment.headSha}, ${assessment.contractRevision}, ${JSON.stringify(assessment)},
        ${assessment.createdAt}
      )
      ON CONFLICT (assessment_id) DO NOTHING
    `,
  });

  const insertExchange = SqlSchema.void({
    Request: Schema.Struct({
      exchange: CollaborativeAcceptanceExchange,
    }),
    execute: ({ exchange }) => sql`
      INSERT INTO collaborative_acceptance_exchanges (
        exchange_id, case_id, execution_id, candidate_id, head_sha, request_id, review_mode,
        status, retry_count, reserved_at, started_at,
        outcome_recorded_at, completed_at, cancelled_at, model_spend_cents, exchange_json
      ) VALUES (
        ${exchange.exchangeId}, ${exchange.caseId}, ${exchange.executionId},
        ${exchange.candidateId ?? null}, ${exchange.headSha ?? null}, ${exchange.requestId ?? null},
        ${exchange.reviewMode ?? null}, ${exchange.status},
        ${exchange.retryCount}, ${exchange.reservedAt}, ${exchange.startedAt},
        ${exchange.outcomeRecordedAt}, ${exchange.completedAt}, ${exchange.cancelledAt},
        ${exchange.modelSpendCents}, ${JSON.stringify(exchange)}
      )
      ON CONFLICT (exchange_id) DO UPDATE SET
        status = excluded.status,
        candidate_id = excluded.candidate_id,
        head_sha = excluded.head_sha,
        request_id = excluded.request_id,
        review_mode = excluded.review_mode,
        retry_count = excluded.retry_count,
        reserved_at = excluded.reserved_at,
        started_at = excluded.started_at,
        outcome_recorded_at = excluded.outcome_recorded_at,
        completed_at = excluded.completed_at,
        cancelled_at = excluded.cancelled_at,
        model_spend_cents = excluded.model_spend_cents,
        exchange_json = excluded.exchange_json
    `,
  });

  const getCaseRow = SqlSchema.findOneOption({
    Request: caseIdInput,
    Result: CollaborativeAcceptanceCaseDbRow,
    execute: ({ caseId }) => sql`
      SELECT revision, case_json AS "case", projection_json AS projection,
        provider_evidence_json AS "providerEvidence", obligations_json AS obligations
      FROM collaborative_acceptance_cases
      WHERE case_id = ${caseId}
    `,
  });

  const listCaseRowsByAssignment = SqlSchema.findAll({
    Request: assignmentIdInput,
    Result: Schema.Struct({
      caseId: CollaborativeAcceptanceCaseId,
      revision: Schema.Number,
      case: CollaborativeAcceptanceCaseDbRow.fields.case,
      projection: CollaborativeAcceptanceCaseDbRow.fields.projection,
      providerEvidence: CollaborativeAcceptanceCaseDbRow.fields.providerEvidence,
      obligations: CollaborativeAcceptanceCaseDbRow.fields.obligations,
    }),
    execute: ({ assignmentId }) => sql`
      SELECT
        case_id AS "caseId",
        revision,
        case_json AS "case",
        projection_json AS projection,
        provider_evidence_json AS "providerEvidence",
        obligations_json AS obligations
      FROM collaborative_acceptance_cases
      WHERE assignment_id = ${assignmentId}
      ORDER BY updated_at DESC, case_id ASC
    `,
  });

  const listCaseRowsByParentThread = SqlSchema.findAll({
    Request: parentThreadIdInput,
    Result: Schema.Struct({
      caseId: CollaborativeAcceptanceCaseId,
      revision: Schema.Number,
      case: CollaborativeAcceptanceCaseDbRow.fields.case,
      projection: CollaborativeAcceptanceCaseDbRow.fields.projection,
      providerEvidence: CollaborativeAcceptanceCaseDbRow.fields.providerEvidence,
      obligations: CollaborativeAcceptanceCaseDbRow.fields.obligations,
    }),
    execute: ({ parentThreadId }) => sql`
      SELECT
        case_id AS "caseId",
        revision,
        case_json AS "case",
        projection_json AS projection,
        provider_evidence_json AS "providerEvidence",
        obligations_json AS obligations
      FROM collaborative_acceptance_cases
      WHERE parent_thread_id = ${parentThreadId}
      ORDER BY updated_at DESC, case_id ASC
    `,
  });

  const listCaseRowsByPullRequest = SqlSchema.findAll({
    Request: pullRequestInput,
    Result: Schema.Struct({
      caseId: CollaborativeAcceptanceCaseId,
      revision: Schema.Number,
      case: CollaborativeAcceptanceCaseDbRow.fields.case,
      projection: CollaborativeAcceptanceCaseDbRow.fields.projection,
      providerEvidence: CollaborativeAcceptanceCaseDbRow.fields.providerEvidence,
      obligations: CollaborativeAcceptanceCaseDbRow.fields.obligations,
    }),
    execute: ({ projectId, repository, number }) => sql`
      SELECT
        case_id AS "caseId",
        revision,
        case_json AS "case",
        projection_json AS projection,
        provider_evidence_json AS "providerEvidence",
        obligations_json AS obligations
      FROM collaborative_acceptance_cases
      WHERE pull_request_project_id = ${projectId}
        AND pull_request_repository = ${repository}
        AND pull_request_number = ${number}
      ORDER BY updated_at DESC, case_id ASC
    `,
  });

  const listAllCaseRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: Schema.Struct({
      caseId: CollaborativeAcceptanceCaseId,
      revision: Schema.Number,
      case: CollaborativeAcceptanceCaseDbRow.fields.case,
      projection: CollaborativeAcceptanceCaseDbRow.fields.projection,
      providerEvidence: CollaborativeAcceptanceCaseDbRow.fields.providerEvidence,
      obligations: CollaborativeAcceptanceCaseDbRow.fields.obligations,
    }),
    execute: () => sql`
      SELECT
        case_id AS "caseId",
        revision,
        case_json AS "case",
        projection_json AS projection,
        provider_evidence_json AS "providerEvidence",
        obligations_json AS obligations
      FROM collaborative_acceptance_cases
      ORDER BY updated_at DESC, case_id ASC
    `,
  });

  const listCandidates = SqlSchema.findAll({
    Request: caseIdInput,
    Result: Schema.Struct({ candidate: CollaborativeAcceptanceCandidateDbRow }),
    execute: ({ caseId }) => sql`
      SELECT candidate_json AS candidate
      FROM collaborative_acceptance_candidates
      WHERE case_id = ${caseId}
      ORDER BY review_epoch ASC
    `,
  });

  const listEvidence = SqlSchema.findAll({
    Request: caseIdInput,
    Result: Schema.Struct({ evidence: CollaborativeAcceptanceEvidenceDbRow }),
    execute: ({ caseId }) => sql`
      SELECT evidence_json AS evidence
      FROM collaborative_acceptance_evidence
      WHERE case_id = ${caseId}
      ORDER BY observed_at ASC, evidence_id ASC
    `,
  });

  const listAssessments = SqlSchema.findAll({
    Request: caseIdInput,
    Result: Schema.Struct({ assessment: CollaborativeAcceptanceAssessmentDbRow }),
    execute: ({ caseId }) => sql`
      SELECT assessment_json AS assessment
      FROM collaborative_acceptance_assessments
      WHERE case_id = ${caseId}
      ORDER BY created_at ASC, assessment_id ASC
    `,
  });

  const listExchanges = SqlSchema.findAll({
    Request: caseIdInput,
    Result: Schema.Struct({ exchange: CollaborativeAcceptanceExchangeDbRow }),
    execute: ({ caseId }) => sql`
      SELECT exchange_json AS exchange
      FROM collaborative_acceptance_exchanges
      WHERE case_id = ${caseId}
      ORDER BY reserved_at ASC, exchange_id ASC
    `,
  });

  const loadRecord = (row: CollaborativeAcceptanceCaseDbRow) =>
    Effect.all({
      candidates: listCandidates({ caseId: row.case.caseId }).pipe(
        Effect.map((rows) => rows.map(({ candidate }) => candidate)),
      ),
      evidence: listEvidence({ caseId: row.case.caseId }).pipe(
        Effect.map((rows) => rows.map(({ evidence }) => evidence)),
      ),
      assessments: listAssessments({ caseId: row.case.caseId }).pipe(
        Effect.map((rows) => rows.map(({ assessment }) => assessment)),
      ),
      exchanges: listExchanges({ caseId: row.case.caseId }).pipe(
        Effect.map((rows) => rows.map(({ exchange }) => exchange)),
      ),
    }).pipe(
      Effect.map(
        ({ candidates, evidence, assessments, exchanges }): CollaborativeAcceptanceRecord => ({
          revision: row.revision,
          case: row.case,
          candidates,
          evidence,
          assessments,
          exchanges,
          ...(row.providerEvidence === null ? {} : { providerEvidence: row.providerEvidence }),
          ...(row.obligations.length === 0 ? {} : { obligations: row.obligations }),
          projection: row.projection,
        }),
      ),
    );

  const save: CollaborativeAcceptanceRepositoryShape["save"] = ({ record, expectedRevision }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{ readonly revision: number }>`
            SELECT revision
            FROM collaborative_acceptance_cases
            WHERE case_id = ${record.case.caseId}
          `;
          const actualRevision = current[0]?.revision ?? null;

          if (actualRevision === null) {
            if (expectedRevision !== null || record.revision !== 0) {
              return yield* Effect.fail(
                new CollaborativeAcceptanceRepositoryConflict({
                  caseId: record.case.caseId,
                  expectedRevision,
                  actualRevision,
                }),
              );
            }
            yield* insertCase({
              case: record.case,
              projection: record.projection,
              providerEvidence: record.providerEvidence ?? null,
              obligations: record.obligations ?? [],
              revision: record.revision,
            });
          } else {
            if (expectedRevision !== actualRevision || record.revision !== expectedRevision) {
              return yield* Effect.fail(
                new CollaborativeAcceptanceRepositoryConflict({
                  caseId: record.case.caseId,
                  expectedRevision,
                  actualRevision,
                }),
              );
            }
            const nextRecord = {
              ...record,
              revision: actualRevision + 1,
            };
            yield* updateCase({
              case: nextRecord.case,
              projection: nextRecord.projection,
              providerEvidence: nextRecord.providerEvidence ?? null,
              obligations: nextRecord.obligations ?? [],
              expectedRevision: actualRevision,
              revision: nextRecord.revision,
            });
            const updated = yield* sql<{ readonly changes: number }>`SELECT changes() AS changes`;
            if (updated[0]?.changes !== 1) {
              return yield* Effect.fail(
                new CollaborativeAcceptanceRepositoryConflict({
                  caseId: record.case.caseId,
                  expectedRevision,
                  actualRevision,
                }),
              );
            }
            record = nextRecord;
          }

          yield* Effect.all(
            record.candidates.map((candidate) =>
              insertCandidate({ caseId: record.case.caseId, candidate }),
            ),
          );
          yield* Effect.all(record.evidence.map((evidence) => insertEvidence({ evidence })));
          yield* Effect.all(
            record.assessments.map((assessment) => insertAssessment({ assessment })),
          );
          yield* Effect.all(record.exchanges.map((exchange) => insertExchange({ exchange })));
          return record;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCollaborativeAcceptanceRepositoryConflict(cause)
            ? cause
            : toPersistenceSqlError("CollaborativeAcceptanceRepository.save")(cause),
        ),
      );

  const getByCaseId: CollaborativeAcceptanceRepositoryShape["getByCaseId"] = (input) =>
    getCaseRow(input).pipe(
      Effect.flatMap((row) =>
        Option.isNone(row)
          ? Effect.succeed(Option.none())
          : loadRecord(row.value).pipe(Effect.map(Option.some)),
      ),
      Effect.mapError(toPersistenceSqlError("CollaborativeAcceptanceRepository.getByCaseId")),
    );

  const listByAssignmentId: CollaborativeAcceptanceRepositoryShape["listByAssignmentId"] = (
    input,
  ) =>
    listCaseRowsByAssignment(input).pipe(
      Effect.flatMap((rows) => Effect.all(rows.map((row) => loadRecord(row)))),
      Effect.mapError(
        toPersistenceSqlError("CollaborativeAcceptanceRepository.listByAssignmentId"),
      ),
    );

  const listByParentThreadId: CollaborativeAcceptanceRepositoryShape["listByParentThreadId"] = (
    input,
  ) =>
    listCaseRowsByParentThread(input).pipe(
      Effect.flatMap((rows) => Effect.all(rows.map((row) => loadRecord(row)))),
      Effect.mapError(
        toPersistenceSqlError("CollaborativeAcceptanceRepository.listByParentThreadId"),
      ),
    );

  const listByPullRequest: CollaborativeAcceptanceRepositoryShape["listByPullRequest"] = (input) =>
    listCaseRowsByPullRequest(input).pipe(
      Effect.flatMap((rows) => Effect.all(rows.map((row) => loadRecord(row)))),
      Effect.mapError(toPersistenceSqlError("CollaborativeAcceptanceRepository.listByPullRequest")),
    );

  const listAll: CollaborativeAcceptanceRepositoryShape["listAll"] = () =>
    listAllCaseRows({}).pipe(
      Effect.flatMap((rows) => Effect.all(rows.map((row) => loadRecord(row)))),
      Effect.mapError(toPersistenceSqlError("CollaborativeAcceptanceRepository.listAll")),
    );

  return {
    save,
    getByCaseId,
    listByAssignmentId,
    listByParentThreadId,
    listByPullRequest,
    listAll,
  };
});

export const CollaborativeAcceptanceRepositoryLive = Layer.effect(
  CollaborativeAcceptanceRepository,
  makeRepository,
);
