import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE run_webhook_subscriptions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      endpoint_fingerprint TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      link TEXT NOT NULL,
      state TEXT NOT NULL,
      last_observation TEXT,
      payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `;
  yield* sql`CREATE INDEX run_webhooks_due ON run_webhook_subscriptions(state, next_attempt_at)`;
  yield* sql`CREATE INDEX run_webhooks_owner ON run_webhook_subscriptions(session_id)`;
});
