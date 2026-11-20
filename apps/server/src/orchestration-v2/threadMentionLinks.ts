import {
  type EnvironmentId,
  OrchestrationV2ThreadMentionLinks,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// json_extract fails on a non-JSON value, and context records are not validated as objects.
const chipField = (name: string) =>
  `json_extract(CASE record.type WHEN 'object' THEN record.value END, '$.${name}')`;

export const insertThreadMentions = (sql: SqlClient.SqlClient, row: "new" | "messages") =>
  sql.literal(`
  INSERT OR IGNORE INTO orchestration_v2_thread_mentions (
    message_id, source_thread_id, target_environment_id, target_thread_id
  )
  SELECT DISTINCT ${row}.message_id, ${row}.thread_id, ${chipField("environmentId")}, ${chipField("threadId")}
  FROM ${row === "messages" ? "orchestration_v2_projection_messages AS messages, " : ""}
    json_each(CASE WHEN json_valid(${row}.payload_json) THEN ${row}.payload_json END, '$.context.records') AS record
  WHERE ${chipField("kind")} = 'thread'
    AND ${chipField("environmentId")} IS NOT NULL
    AND ${chipField("threadId")} IS NOT NULL
    AND ${chipField("threadId")} IS NOT ${row}.thread_id;
`);

export const createThreadMentionTriggers = Effect.fn("ThreadMentionLinks.createTriggers")(
  function* (sql: SqlClient.SqlClient) {
    yield* sql`
      CREATE TRIGGER orchestration_v2_thread_mentions_insert
      AFTER INSERT ON orchestration_v2_projection_messages
      BEGIN
        ${insertThreadMentions(sql, "new")}
      END
    `;
    yield* sql`
      CREATE TRIGGER orchestration_v2_thread_mentions_update
      AFTER UPDATE OF payload_json, thread_id, streaming ON orchestration_v2_projection_messages
      WHEN old.thread_id IS NOT new.thread_id
        OR (new.streaming = 0
          AND (old.streaming = 1
            OR json_extract(CASE WHEN json_valid(old.payload_json) THEN old.payload_json END, '$.context')
              IS NOT json_extract(CASE WHEN json_valid(new.payload_json) THEN new.payload_json END, '$.context')))
      BEGIN
        DELETE FROM orchestration_v2_thread_mentions WHERE message_id = old.message_id;
        ${insertThreadMentions(sql, "new")}
      END
    `;
    yield* sql`
      CREATE TRIGGER orchestration_v2_thread_mentions_delete
      AFTER DELETE ON orchestration_v2_projection_messages
      BEGIN
        DELETE FROM orchestration_v2_thread_mentions WHERE message_id = old.message_id;
      END
    `;
  },
);

const visibleThread = (alias: string, threadId: string) => `
  EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS ${alias}
    WHERE ${alias}.thread_id = ${threadId}
      AND ${alias}.deleted_at IS NULL
      AND json_extract(${alias}.payload_json, '$.lineage.sideChat') IS NOT 1
      AND NOT EXISTS (
        SELECT 1 FROM projection_projects AS ${alias}_project
        WHERE ${alias}_project.project_id = ${alias}.project_id
          AND ${alias}_project.deleted_at IS NOT NULL
      )
  )
`;

const decodeLinks = Schema.decodeUnknownEffect(OrchestrationV2ThreadMentionLinks);

export const listThreadMentionLinks = Effect.fn("ThreadMentionLinks.list")(function* (input: {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const links = yield* sql<{ readonly threadId: string; readonly direction: string }>`
    SELECT DISTINCT link.other_id AS "threadId", link.direction
    FROM (
      SELECT mentions.message_id, mentions.target_thread_id AS other_id,
        mentions.source_thread_id AS own_id, 'mentions' AS direction
      FROM orchestration_v2_thread_mentions AS mentions
      WHERE mentions.source_thread_id = ${input.threadId}
        AND mentions.target_environment_id = ${input.environmentId}
      UNION
      SELECT mentions.message_id, mentions.source_thread_id AS other_id,
        mentions.target_thread_id AS own_id, 'mentionedBy' AS direction
      FROM orchestration_v2_thread_mentions AS mentions
      WHERE mentions.target_thread_id = ${input.threadId}
        AND mentions.target_environment_id = ${input.environmentId}
    ) AS link
    INNER JOIN orchestration_v2_projection_messages AS messages
      ON messages.message_id = link.message_id
    LEFT JOIN orchestration_v2_projection_runs AS runs ON runs.run_id = messages.run_id
    WHERE runs.status IS NOT 'rolled_back'
      AND NOT (runs.status IS 'cancelled' AND json_extract(runs.payload_json, '$.startedAt') IS NULL)
      AND ${sql.literal(visibleThread("other_thread", "link.other_id"))}
      AND ${sql.literal(visibleThread("own_thread", "link.own_id"))}
    ORDER BY "threadId", direction
  `.pipe(NodeSqliteClient.readOnly);
  return yield* decodeLinks({ links });
});
