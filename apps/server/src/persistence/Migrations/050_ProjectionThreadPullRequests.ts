import { legacyThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface LegacyLinkedThreadRow {
  readonly threadId: string;
  readonly updatedAt: string;
  readonly linkedPullRequestJson: string;
}

interface LegacyLinkedPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function parseLegacyLinkedPullRequest(json: string): LegacyLinkedPullRequest | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return null;
    const { repository, number, url } = value as Record<string, unknown>;
    if (typeof repository !== "string" || repository.trim().length === 0) return null;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
    if (typeof url !== "string" || url.trim().length === 0) return null;
    return { repository, number, url };
  } catch {
    return null;
  }
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_pull_requests (
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      snapshot_json TEXT,
      stack_json TEXT,
      PRIMARY KEY (thread_id, host, repository, number)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_pull_requests_pr
    ON projection_thread_pull_requests(host, repository, number)
  `;

  const legacyRows = yield* sql<LegacyLinkedThreadRow>`
    SELECT
      thread_id AS "threadId",
      updated_at AS "updatedAt",
      linked_pull_request_json AS "linkedPullRequestJson"
    FROM projection_threads
    WHERE linked_pull_request_json IS NOT NULL
  `;

  for (const row of legacyRows) {
    const linked = parseLegacyLinkedPullRequest(row.linkedPullRequestJson);
    if (linked === null) continue;
    const key = legacyThreadPullRequestKey(linked);
    yield* sql`
      INSERT OR IGNORE INTO projection_thread_pull_requests (
        thread_id,
        host,
        repository,
        number,
        url,
        source,
        linked_at,
        snapshot_json,
        stack_json
      )
      VALUES (
        ${row.threadId},
        ${key.host},
        ${key.repository},
        ${linked.number},
        ${linked.url},
        'manual',
        ${row.updatedAt},
        NULL,
        NULL
      )
    `;
  }
});
