import {
  IssueLinkedThreadsResult,
  IssueOperationError,
  threadIssueKeysEqual,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeLinkedThreads = Schema.decodeUnknownEffect(IssueLinkedThreadsResult);

/** The threads an issue is linked to; the rows and filters `linkedThreads` uses for pull requests. */
export const listLinkedIssueThreads = Effect.fn("listLinkedIssueThreads")(
  function* (key: ThreadIssueKey) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      id: string;
      projectId: string;
      title: string;
      archivedAt: string | null;
      settled: number;
      tracker: ThreadIssueKey["tracker"];
      host: string;
      scope: string;
      key: string;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt",
        (json_extract(t.payload_json, '$.settledAt') IS NOT NULL
          OR json_extract(t.payload_json, '$.settledOverride') IS 'settled') AS settled,
        json_extract(link.value, '$.tracker') AS tracker,
        json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.scope') AS scope,
        json_extract(link.value, '$.key') AS key,
        t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.issues') AS link
      WHERE json_extract(link.value, '$.key') = ${key.key.trim()}
        AND t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
      ORDER BY "updatedAt" DESC, id ASC
    `.pipe(NodeSqliteClient.readOnly);
    const threads = rows
      .filter((row) => threadIssueKeysEqual(row, key))
      .map(({ id, projectId, title, archivedAt, settled }) => ({
        id,
        projectId,
        title,
        archivedAt,
        settled: settled === 1,
      }));
    return yield* decodeLinkedThreads({ threads });
  },
  Effect.mapError(
    (cause) =>
      new IssueOperationError({
        operation: "linkedThreads",
        detail: "Could not load linked threads.",
        cause,
      }),
  ),
);
