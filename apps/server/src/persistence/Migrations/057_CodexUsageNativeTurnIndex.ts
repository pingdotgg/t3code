import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_provider_turns_codex_native_id_idx
    ON orchestration_v2_projection_provider_turns (
      json_extract(payload_json, '$.nativeTurnRef.nativeId')
    )
    WHERE json_extract(payload_json, '$.nativeTurnRef.driver') = 'codex'
  `;
});
