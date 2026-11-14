import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import {
  PullRequestLinkedThreadsResult,
  PullRequestOperationError,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
      settled: number;
      host: string;
      repository: string;
      number: number;
      url: string;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt",
        (json_extract(t.payload_json, '$.settledAt') IS NOT NULL
          OR json_extract(t.payload_json, '$.settledOverride') IS 'settled') AS settled,
        json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number,
        json_extract(link.value, '$.url') AS url,
        t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.pullRequests') AS link
      WHERE json_extract(link.value, '$.number') = ${key.number}
        AND json_extract(link.value, '$.source') != 'stack-dismissed'
        AND t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
      ORDER BY "updatedAt" DESC, id ASC
    `.pipe(NodeSqliteClient.readOnly);
    const threads = rows
      .filter((row) => threadPullRequestKeysEqual(row, key))
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
      new PullRequestOperationError({
        operation: "linkedThreads",
        detail: "Could not load linked threads.",
        cause,
      }),
  ),
);

// Mirrors the rows and filters of `listLinkedPullRequestThreads`.
function linkedKeys(thread: OrchestrationV2AppThread): ReadonlyArray<string> {
  if (thread.deletedAt !== null || thread.lineage.sideChat === true) return [];
  return visibleThreadPullRequests(thread.pullRequests ?? [])
    .map(threadPullRequestKeyOf)
    .toSorted();
}

function linkedThreadsView(
  thread: OrchestrationV2AppThread,
  keys: ReadonlyArray<string>,
): string | null {
  if (keys.length === 0) return null;
  const settled = thread.settledAt !== null || thread.settledOverride === "settled";
  return JSON.stringify([
    keys,
    thread.title,
    thread.projectId,
    thread.archivedAt !== null,
    settled,
  ]);
}

/**
 * Tells how a domain event changed `pullRequests.linkedThreads` answers, so readers can refresh on
 * change instead of polling. `reordered` means activity on a linked thread, or on one whose links
 * are unknown since a restart, which can reorder answers. A thread's first full event after a
 * restart counts as a change, since its earlier links are unknown.
 */
export function makeLinkedThreadsChangeDetector() {
  const views = new Map<ThreadId, string | null>();
  // Last activity of each thread with visible links.
  const activeAt = new Map<ThreadId, number>();
  const active = (threadId: ThreadId, at: DateTime.Utc): boolean => {
    const previous = activeAt.get(threadId);
    if (previous === undefined) return false;
    const millis = DateTime.toEpochMillis(at);
    if (millis <= previous) return false;
    activeAt.set(threadId, millis);
    return true;
  };
  return (event: OrchestrationV2DomainEvent): "changed" | "reordered" | null => {
    // The projection stamps every non-thread event as the thread's activity. A thread not seen
    // since startup may be linked already, since history is not replayed.
    if (!event.type.startsWith("thread.")) {
      if (!views.has(event.threadId)) return "reordered";
      return active(event.threadId, event.occurredAt) ? "reordered" : null;
    }
    if (!("lineage" in event.payload)) return null;
    const thread = event.payload;
    const view = linkedThreadsView(thread, linkedKeys(thread));
    const known = views.has(event.threadId) || event.type === "thread.created";
    const previous = views.get(event.threadId) ?? null;
    if (event.type === "thread.deleted") views.delete(event.threadId);
    else views.set(event.threadId, view);
    if (view === null) activeAt.delete(event.threadId);
    if (!known || view !== previous) {
      if (view !== null) activeAt.set(event.threadId, DateTime.toEpochMillis(thread.updatedAt));
      return "changed";
    }
    return active(event.threadId, thread.updatedAt) ? "reordered" : null;
  };
}
