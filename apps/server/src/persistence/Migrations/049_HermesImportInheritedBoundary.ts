import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records the imported (inherited) Hermes history length on the import
 * ledger. Messages before this boundary receive imported-transcript
 * normalization and activity rehydration; native T3 messages appended after
 * the import remain untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(hermes_session_imports)
  `;
  if (columns.some(({ name }) => name === "inherited_message_count")) return;

  yield* sql`
    ALTER TABLE hermes_session_imports
    ADD COLUMN inherited_message_count INTEGER
  `;
});
