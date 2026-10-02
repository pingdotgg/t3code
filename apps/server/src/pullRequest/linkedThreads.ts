import {
  legacyThreadPullRequestKey,
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import {
  PullRequestLinkedThreadsResult,
  PullRequestOperationError,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeLinkedThreads = Schema.decodeUnknownEffect(PullRequestLinkedThreadsResult);

export const listLinkedPullRequestThreads = Effect.fn("listLinkedPullRequestThreads")(
  function* (input: ThreadPullRequestKey) {
    const key = normalizeThreadPullRequestKey(input);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      id: string;
      projectId: string;
      title: string;
      archivedAt: string | null;
      host: string | null;
      repository: string;
      number: number;
      url: string;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt", json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number,
        json_extract(link.value, '$.url') AS url,
        t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.pullRequests') AS link
      WHERE json_extract(link.value, '$.number') = ${key.number}
        AND json_extract(link.value, '$.source') != 'stack-dismissed'
        AND t.deleted_at IS NULL
      UNION ALL
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt", NULL AS host,
        json_extract(t.payload_json, '$.linkedPullRequest.repository') AS repository,
        json_extract(t.payload_json, '$.linkedPullRequest.number') AS number,
        json_extract(t.payload_json, '$.linkedPullRequest.url') AS url,
        t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS t
      WHERE json_type(t.payload_json, '$.pullRequests') IS NULL
        AND json_type(t.payload_json, '$.linkedPullRequest') = 'object'
        AND json_extract(t.payload_json, '$.linkedPullRequest.number') = ${key.number}
        AND t.deleted_at IS NULL
      ORDER BY "updatedAt" DESC, id ASC
    `;
    const threads = rows
      .filter((row) =>
        threadPullRequestKeysEqual(
          row.host === null ? legacyThreadPullRequestKey(row) : { ...row, host: row.host },
          key,
        ),
      )
      .map(({ id, projectId, title, archivedAt }) => ({ id, projectId, title, archivedAt }));
    return yield* decodeLinkedThreads({ threads });
  },
  Effect.mapError(
    (cause) =>
      new PullRequestOperationError({
        operation: "linkedThreads",
        detail: "Could not load linked threads.",
        cause,
      }),
  ),
);
