import { ThreadLinkedPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";
import { legacyThreadPullRequestKey } from "./legacyThreadPullRequestKey.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeLegacyLink = Schema.decodeEffect(Schema.fromJsonString(ThreadLinkedPullRequest));
const encodeLinks = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ThreadPullRequestLink)));
const linksJson = Effect.fnUntraced(function* (linkedPullRequestJson: string, linkedAt: string) {
  const linked = yield* decodeLegacyLink(linkedPullRequestJson);
  return encodeLinks([
    {
      ...legacyThreadPullRequestKey(linked),
      url: linked.url,
      source: "manual",
      linkedAt,
      snapshot: null,
      stack: null,
    },
  ]);
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pageSize = 500;
  let afterThreadId = "";
  while (true) {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly linked_pull_request_json: string;
      readonly updated_at: string;
    }>`
      SELECT thread_id, json_extract(payload_json, '$.linkedPullRequest') AS linked_pull_request_json,
        updated_at
      FROM orchestration_v2_projection_threads
      WHERE thread_id > ${afterThreadId}
        AND json_type(payload_json, '$.pullRequests') IS NULL
        AND json_type(payload_json, '$.linkedPullRequest') = 'object'
      ORDER BY thread_id
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      const pullRequests = yield* linksJson(row.linked_pull_request_json, row.updated_at);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.pullRequests', json(${pullRequests}))
        WHERE thread_id = ${row.thread_id}
      `;
    }
    if (rows.length < pageSize) break;
    afterThreadId = rows.at(-1)!.thread_id;
  }

  // Normalize the source events too, so rebuilding projections cannot restore the old shape.
  let afterSequence = 0;
  while (true) {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly linked_pull_request_json: string;
      readonly updated_at: string;
    }>`
      SELECT sequence, json_extract(payload_json, '$.linkedPullRequest') AS linked_pull_request_json,
        json_extract(payload_json, '$.updatedAt') AS updated_at
      FROM orchestration_events
      WHERE sequence > ${afterSequence}
        AND application_event_version = 2 AND aggregate_kind = 'thread'
        AND event_type LIKE 'thread.%'
        AND json_type(payload_json, '$.pullRequests') IS NULL
        AND json_type(payload_json, '$.linkedPullRequest') = 'object'
      ORDER BY sequence
      LIMIT ${pageSize}
    `;
    for (const row of rows) {
      const pullRequests = yield* linksJson(row.linked_pull_request_json, row.updated_at);
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.pullRequests', json(${pullRequests}))
        WHERE sequence = ${row.sequence}
      `;
    }
    if (rows.length < pageSize) break;
    afterSequence = rows.at(-1)!.sequence;
  }
});
