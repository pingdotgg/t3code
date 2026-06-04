import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

const LOCAL_EXECUTION_TARGET_JSON = '{"kind":"local"}';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projColumns.some((col) => col.name === "execution_target_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN execution_target_json TEXT
    `.pipe(Effect.orDie);
  }

  yield* sql`
    UPDATE projection_projects
    SET execution_target_json = ${LOCAL_EXECUTION_TARGET_JSON}
    WHERE execution_target_json IS NULL
  `;

  const runtimeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!runtimeColumns.some((col) => col.name === "execution_target_json")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN execution_target_json TEXT
    `.pipe(Effect.orDie);
  }

  yield* sql`
    UPDATE provider_session_runtime
    SET execution_target_json = ${LOCAL_EXECUTION_TARGET_JSON}
    WHERE execution_target_json IS NULL
  `;
});
