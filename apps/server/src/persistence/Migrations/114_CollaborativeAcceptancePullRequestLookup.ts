import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(collaborative_acceptance_cases)
  `;
  const names = new Set(columns.map(({ name }) => name));

  if (!names.has("pull_request_project_id")) {
    yield* sql`ALTER TABLE collaborative_acceptance_cases ADD COLUMN pull_request_project_id TEXT`;
  }
  if (!names.has("pull_request_repository")) {
    yield* sql`ALTER TABLE collaborative_acceptance_cases ADD COLUMN pull_request_repository TEXT`;
  }
  if (!names.has("pull_request_number")) {
    yield* sql`ALTER TABLE collaborative_acceptance_cases ADD COLUMN pull_request_number INTEGER`;
  }

  yield* sql`
    UPDATE collaborative_acceptance_cases
    SET
      pull_request_project_id = json_extract(case_json, '$.pullRequest.projectId'),
      pull_request_repository = json_extract(case_json, '$.pullRequest.repository'),
      pull_request_number = json_extract(case_json, '$.pullRequest.number')
    WHERE pull_request_project_id IS NULL
      AND json_valid(case_json)
      AND json_type(case_json, '$.pullRequest.projectId') = 'text'
      AND json_type(case_json, '$.pullRequest.repository') = 'text'
      AND json_type(case_json, '$.pullRequest.number') = 'integer'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_collaborative_acceptance_cases_pull_request
    ON collaborative_acceptance_cases(
      pull_request_project_id,
      pull_request_repository,
      pull_request_number,
      updated_at DESC
    )
  `;
});
