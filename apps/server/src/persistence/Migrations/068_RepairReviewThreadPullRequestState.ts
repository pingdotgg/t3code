import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import OrchestrationEvents from "./001_OrchestrationEvents.ts";
import BackfillReviewThreadPullRequests from "./067_BackfillReviewThreadPullRequests.ts";

/**
 * Migration 067 initially inferred "open" for legacy review snapshots. Repair
 * only legacy thread.created events that omitted pullRequest entirely; explicit
 * associations retain their known state.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* OrchestrationEvents;
  yield* BackfillReviewThreadPullRequests;

  yield* sql`
    UPDATE projection_threads
    SET pull_request_json = json_set(pull_request_json, '$.state', NULL)
    WHERE json_extract(pull_request_json, '$.state') = 'open'
      AND json_extract(review_snapshot_json, '$.scope.kind') = 'pull-request'
      AND EXISTS (
        SELECT 1
        FROM orchestration_events
        WHERE stream_id = projection_threads.thread_id
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
          AND json_extract(payload_json, '$.reviewSnapshot.scope.kind') = 'pull-request'
          AND json_type(payload_json, '$.pullRequest') IS NULL
      )
  `;
});
