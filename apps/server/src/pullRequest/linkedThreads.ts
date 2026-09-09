import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
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
    const threads = yield* sql`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt"
      FROM projection_thread_pull_requests AS link
      JOIN projection_threads AS t ON t.thread_id = link.thread_id
      WHERE link.host = ${key.host.toLowerCase()}
        AND link.repository = ${key.repository.toLowerCase()}
        AND link.number = ${key.number}
        AND link.source != 'stack-dismissed'
        AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC, t.thread_id ASC
    `;
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
