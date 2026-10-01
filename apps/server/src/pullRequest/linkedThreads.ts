import {
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
    const hostname = key.host.replace(/:\d+$/u, "");
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      id: string;
      projectId: string;
      title: string;
      archivedAt: string | null;
      host: string;
      repository: string;
      number: number;
      url: string;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt", link.host, link.repository, link.number, link.url
      FROM projection_thread_pull_requests AS link
      JOIN projection_threads AS t ON t.thread_id = link.thread_id
      WHERE (link.host = ${key.host} OR link.host = ${hostname})
        AND link.repository = ${key.repository.toLowerCase()}
        AND link.number = ${key.number}
        AND link.source != 'stack-dismissed'
        AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC, t.thread_id ASC
    `;
    const threads = rows
      .filter((row) => threadPullRequestKeysEqual(row, key))
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
