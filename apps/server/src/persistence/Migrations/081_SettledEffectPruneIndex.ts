import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep this predicate aligned with EffectOutbox.pruneSettled's status filter.
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_settled_completed_idx
    ON orchestration_v2_effect_outbox(status, completed_at)
    WHERE status IN ('succeeded', 'cancelled')
  `;
});
