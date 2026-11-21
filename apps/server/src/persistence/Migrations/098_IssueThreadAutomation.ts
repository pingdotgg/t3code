import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { THREAD_ORGANIZATION_EVENT_CONDITION } from "../../orchestration-v2/threadOrganizationEvent.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_thread_automation (
      thread_id TEXT PRIMARY KEY NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  // ProjectionStore.getIssueAutomationRevision reads a thread's newest such event from here.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_thread_organization
    ON orchestration_events(stream_id, sequence)
    WHERE ${THREAD_ORGANIZATION_EVENT_CONDITION}
  `);
});
