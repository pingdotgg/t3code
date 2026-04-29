import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

const LOCAL_EXECUTION_TARGET_JSON = '{"kind":"local"}';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN execution_target_json TEXT
  `.pipe(Effect.orDie);

  yield* sql`
    UPDATE projection_projects
    SET execution_target_json = ${LOCAL_EXECUTION_TARGET_JSON}
    WHERE execution_target_json IS NULL
  `;

  yield* sql`
    ALTER TABLE provider_session_runtime
    ADD COLUMN execution_target_json TEXT
  `.pipe(Effect.orDie);

  yield* sql`
    UPDATE provider_session_runtime
    SET execution_target_json = ${LOCAL_EXECUTION_TARGET_JSON}
    WHERE execution_target_json IS NULL
  `;
});
