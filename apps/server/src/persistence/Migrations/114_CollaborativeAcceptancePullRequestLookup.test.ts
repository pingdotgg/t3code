import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("backfills indexed pull-request identity for existing acceptance cases", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 112 });
    yield* sql`
      INSERT INTO collaborative_acceptance_cases (
        case_id, assignment_id, parent_thread_id, contract_revision,
        current_candidate_id, current_head_sha, case_json, projection_json,
        provider_evidence_json, obligations_json, revision, created_at, updated_at
      ) VALUES (
        'case-before-pr-index', 'assignment', 'parent', 'contract', 'candidate', 'head',
        ${JSON.stringify({
          pullRequest: {
            projectId: "project-before-index",
            repository: "owner/repository",
            number: 42,
          },
        })}, '{}', NULL, '[]', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;

    yield* runMigrations({ toMigrationInclusive: 114 });

    const rows = yield* sql<{
      readonly pull_request_project_id: string | null;
      readonly pull_request_repository: string | null;
      readonly pull_request_number: number | null;
    }>`
      SELECT pull_request_project_id, pull_request_repository, pull_request_number
      FROM collaborative_acceptance_cases
      WHERE case_id = 'case-before-pr-index'
    `;
    assert.deepStrictEqual(rows, [
      {
        pull_request_project_id: "project-before-index",
        pull_request_repository: "owner/repository",
        pull_request_number: 42,
      },
    ]);

    const indexes = yield* sql<{ readonly name: string }>`
      PRAGMA index_list(collaborative_acceptance_cases)
    `;
    assert.isTrue(
      indexes.some(({ name }) => name === "idx_collaborative_acceptance_cases_pull_request"),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
