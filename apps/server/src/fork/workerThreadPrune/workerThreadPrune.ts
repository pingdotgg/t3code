import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";

export const WORKER_THREAD_IDLE_TIME = Duration.days(7);
// SQLite's busy handler sleeps up to 100 ms between tries, so a writer that waits on one
// transaction would otherwise keep missing the lock between back-to-back transactions.
const LOCK_HANDOFF_PAUSE = Duration.millis(100);

/**
 * The transcript of a worker thread. The thread row, runs, run attempts, subagent records, provider
 * and checkpoint records, and pull request links stay, so lists, parents, and usage still read them.
 */
export const WORKER_CONTENT_TABLES = [
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_runtime_requests",
] as const;
export type WorkerContentTable = (typeof WORKER_CONTENT_TABLES)[number];
export type WorkerContentRows = Readonly<Record<WorkerContentTable, number>>;

const RECOVERY_KINDS = Object.keys({
  "queued-runs": true,
  runtime: true,
  "restart-continuations": true,
  "subagent-results": true,
  "delegated-completions": true,
  "unread-steers": true,
} satisfies Record<
  ProjectionStore.ProjectionRecoveryKind,
  true
>) as Array<ProjectionStore.ProjectionRecoveryKind>;
const TERMINAL_RUN_STATUSES = Object.keys({
  completed: true,
  interrupted: true,
  failed: true,
  cancelled: true,
  rolled_back: true,
} satisfies Record<ThreadManagementTerminalRunStatus, true>);

export interface WorkerThreadPrunePlan {
  readonly now: DateTime.Utc;
  readonly workerThreadCount: number;
  /** Idle workers that keep their transcript because recovery, a child, or a fork reads it. */
  readonly keptThreadCount: number;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly rows: WorkerContentRows;
  /** Bytes of the rows' own values; index entries and page slack free more. */
  readonly rowBytes: number;
}

export interface WorkerThreadPruneResult {
  readonly prunedThreadCount: number;
  /** Planned threads whose transcript the check at delete time kept. */
  readonly skippedThreadCount: number;
  readonly rows: WorkerContentRows;
  readonly usedBytesBefore: number;
  readonly usedBytesAfter: number;
  /** A running server returns freed pages to disk only in incremental auto_vacuum mode. */
  readonly incrementalVacuum: boolean;
}

const emptyRows = (): Record<WorkerContentTable, number> =>
  Object.fromEntries(WORKER_CONTENT_TABLES.map((table) => [table, 0])) as Record<
    WorkerContentTable,
    number
  >;

/**
 * A worker is a thread an agent started as its subagent: its lineage names a parent with the
 * subagent relationship. Top-level threads have no parent, and a person's fork names its source as
 * a fork, so neither ever matches.
 */
const isWorkerThread = (row: ThreadLinkRow) =>
  row.relationship_to_parent === "subagent" && row.parent_thread_id !== null;

type ThreadLinkRow = {
  readonly thread_id: string;
  readonly parent_thread_id: string | null;
  readonly relationship_to_parent: string | null;
  readonly fork_source_thread_id: string | null;
};

const readThreadLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<ThreadLinkRow>`
    SELECT
      thread_id,
      json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
      json_extract(payload_json, '$.forkedFrom.threadId') AS fork_source_thread_id
    FROM orchestration_v2_projection_threads
  `.pipe(NodeSqliteClient.readOnly);
});

// Per thread, so the check under the write lock reads the activity of only the threads it checks.
const isIdle = Effect.fnUntraced(function* (threadId: string, now: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly last_activity_at: string; readonly open_runs: number }>`
    SELECT
      MAX(
        thread.created_at,
        COALESCE((
          SELECT MAX(MAX(requested_at, COALESCE(completed_at, '')))
          FROM orchestration_v2_projection_runs WHERE thread_id = thread.thread_id
        ), ''),
        COALESCE((
          SELECT MAX(updated_at) FROM orchestration_v2_projection_turn_items
          WHERE thread_id = thread.thread_id
        ), ''),
        COALESCE((
          SELECT MAX(updated_at) FROM orchestration_v2_projection_messages
          WHERE thread_id = thread.thread_id
        ), '')
      ) AS last_activity_at,
      (
        SELECT COUNT(*) FROM orchestration_v2_projection_runs
        WHERE thread_id = thread.thread_id AND status NOT IN ${sql.in(TERMINAL_RUN_STATUSES)}
      ) AS open_runs
    FROM orchestration_v2_projection_threads AS thread
    WHERE thread.thread_id = ${threadId}
  `.pipe(NodeSqliteClient.readOnly);
  const row = rows[0];
  const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, WORKER_THREAD_IDLE_TIME));
  return row !== undefined && row.open_runs === 0 && row.last_activity_at < cutoff;
});

/** Recovery reads its threads' transcripts on the next start, for example to deliver a result. */
const readRecoveringThreadIds = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return new Set<string>(
    (yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
      projections.getRecoveryThreadIds(kind),
    )).flat(),
  );
});

/**
 * The idle workers among `candidates` (all workers by default) that nothing still reads. A thread
 * that keeps its transcript keeps its parent's and fork source's too, since child work reports into
 * the parent and a fork shows its source's history.
 */
const findPrunable = Effect.fnUntraced(function* (
  now: DateTime.Utc,
  recovering: ReadonlySet<string>,
  candidates?: ReadonlyArray<string>,
) {
  const links = yield* readThreadLinks;
  const workers = links.filter(isWorkerThread).map((link) => link.thread_id);
  const workerIds = new Set(workers);
  const linkedTo = Map.groupBy(
    links.flatMap((link) => [
      [link.parent_thread_id, link.thread_id] as const,
      [link.fork_source_thread_id, link.thread_id] as const,
    ]),
    ([target]) => target,
  );
  const idle = new Map<string, boolean>();
  const isIdleWorker = Effect.fnUntraced(function* (threadId: string) {
    const known = idle.get(threadId);
    if (known !== undefined) return known;
    const result = workerIds.has(threadId) && (yield* isIdle(threadId, now));
    idle.set(threadId, result);
    return result;
  });

  let idleCount = 0;
  const prunable: Array<string> = [];
  candidates: for (const candidate of candidates ?? workers) {
    if (!(yield* isIdleWorker(candidate))) continue;
    idleCount++;
    const subtree = new Set([candidate]);
    for (const threadId of subtree) {
      if (recovering.has(threadId) || !(yield* isIdleWorker(threadId))) continue candidates;
      for (const [, linked] of linkedTo.get(threadId) ?? []) subtree.add(linked);
    }
    prunable.push(candidate);
  }
  return { workerCount: workers.length, idleCount, prunable };
});

const readUsedBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [pages] = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const [free] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const [size] = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  return ((pages?.page_count ?? 0) - (free?.freelist_count ?? 0)) * (size?.page_size ?? 0);
});

/** Finds worker threads idle for WORKER_THREAD_IDLE_TIME whose transcript nothing still reads. */
export const planWorkerThreadPrune = Effect.fn("WorkerThreadPrune.plan")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const { workerCount, idleCount, prunable } = yield* findPrunable(
    now,
    yield* readRecoveringThreadIds,
  );

  const columns = new Map<WorkerContentTable, string>();
  for (const table of WORKER_CONTENT_TABLES) {
    const info = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `.pipe(NodeSqliteClient.readOnly);
    columns.set(
      table,
      info.map(({ name }) => `COALESCE(LENGTH(CAST("${name}" AS BLOB)), 0)`).join(" + "),
    );
  }
  const rows = emptyRows();
  let rowBytes = 0;
  const threadIds: Array<ThreadId> = [];
  for (const threadId of prunable) {
    let threadRows = 0;
    for (const table of WORKER_CONTENT_TABLES) {
      const [measured] = yield* sql<{ readonly count: number; readonly bytes: number | null }>`
        SELECT COUNT(*) AS count, SUM(${sql.literal(columns.get(table)!)}) AS bytes
        FROM ${sql(table)} WHERE thread_id = ${threadId}
      `.pipe(NodeSqliteClient.readOnly);
      rows[table] += measured?.count ?? 0;
      rowBytes += measured?.bytes ?? 0;
      threadRows += measured?.count ?? 0;
    }
    if (threadRows > 0) threadIds.push(ThreadId.make(threadId));
  }
  return {
    now,
    workerThreadCount: workerCount,
    keptThreadCount: idleCount - prunable.length,
    threadIds,
    rows,
    rowBytes,
  } satisfies WorkerThreadPrunePlan;
});

/**
 * Deletes each planned thread's transcript in its own transaction, which first checks again that
 * the thread and the threads that name it are idle, so a thread needed again keeps its rows. The
 * recovery queries scan the whole database, so they run once, outside the transactions that hold
 * the write lock. A thread that gets an open run or new activity after that still fails the check.
 */
export const pruneWorkerThreads = Effect.fn("WorkerThreadPrune.prune")(function* (
  plan: WorkerThreadPrunePlan,
) {
  const sql = yield* SqlClient.SqlClient;
  const usedBytesBefore = yield* readUsedBytes;
  const recovering = yield* readRecoveringThreadIds;
  const rows = emptyRows();
  let prunedThreadCount = 0;
  let skippedThreadCount = 0;
  for (const threadId of plan.threadIds) {
    const deleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* findPrunable(plan.now, recovering, [threadId])).prunable.length === 0) {
          return null;
        }
        const counts = emptyRows();
        for (const table of WORKER_CONTENT_TABLES) {
          yield* sql`DELETE FROM ${sql(table)} WHERE thread_id = ${threadId}`;
          // changes() leaves out the message search rows the delete trigger removes.
          const [result] = yield* sql<{ readonly count: number }>`SELECT changes() AS count`;
          counts[table] = result?.count ?? 0;
        }
        return counts;
      }),
    );
    yield* Effect.sleep(LOCK_HANDOFF_PAUSE);
    if (deleted === null) {
      skippedThreadCount++;
      continue;
    }
    prunedThreadCount++;
    for (const table of WORKER_CONTENT_TABLES) rows[table] += deleted[table];
  }
  const [mode] = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  return {
    prunedThreadCount,
    skippedThreadCount,
    rows,
    usedBytesBefore,
    usedBytesAfter: yield* readUsedBytes,
    incrementalVacuum: mode?.auto_vacuum === 2,
  } satisfies WorkerThreadPruneResult;
});
