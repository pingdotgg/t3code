/**
 * Adds the nullable `provider_instance_id` routing column to
 * `provider_session_runtime`.
 *
 * Slice D of the provider-array refactor splits "driver kind" from
 * "configured instance". Existing rows have only the driver name in
 * `provider_name`; new rows additionally carry the user-defined instance
 * routing key. The column remains nullable so legacy rows can still decode;
 * the persistence boundary is responsible for materializing a concrete
 * instance id before any hot routing path sees the binding.
 *
 * The column is nullable on purpose — backfilling it during the migration
 * would require knowing which configured instance "owned" each historical
 * session, and that mapping is ambiguous when the user later configures
 * multiple instances of the same driver. Keeping that compatibility at the
 * persistence boundary keeps the fallback out of active routing code.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!columns.some((column) => column.name === "provider_instance_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_instance
    ON provider_session_runtime(provider_instance_id)
  `;
});
