import type { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import {
  EVENT_LOG_PRUNE_MARK,
  EVENT_LOG_PRUNED_THROUGH,
} from "../persistence/OrchestrationEventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  /**
   * Deletes events the projections already cover once they are older than the retained history,
   * then purges any deleted thread that still holds conversation content.
   */
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly purgedRowCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
  /**
   * Removes a deleted thread's conversation, and that of deleted run-fork sources it alone kept.
   * Returns the number of rows removed.
   */
  readonly purgeDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionMaintenanceError>;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

// Reconnect replay and command-id retries read this tail; older cursors resync from a snapshot.
const RETAINED_EVENT_HISTORY = Duration.days(1);
// Small pages bound work on the reader worker and synchronous fallback.
const PAGE_SIZE = 50;
const REFERENCE_SCAN_WINDOW = 1000;
// Bounds how long one purge statement holds the writer: on a real database a 500-row batch of
// turn items took about 400 ms, index and count-trigger work included.
const PURGE_BATCH_SIZE = 50;
// Titles default to the first message, so a tombstone cannot keep the real one.
export const DELETED_THREAD_TITLE = "Deleted thread";

// Every thread_id table that holds conversation text. The thread row stays as the tombstone, and
// the metadata that storage cleanup and usage history still read (checkpoints, provider sessions,
// provider turns, run attempts, context transfers) stays with it.
export const DELETED_THREAD_CONTENT_TABLES = [
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_plans",
  "mcp_app_model_context",
  // A legacy thread's transcript source; deleting it means the importer has nothing to restore.
  "projection_thread_messages",
] as const;

type MetadataRow = {
  readonly projection_name: string;
  readonly last_sequence: number;
  readonly updated_at: string;
};

export const layer: Layer.Layer<ProjectionMaintenanceV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const writeMetadata = (name: string, sequence: number, at: DateTime.Utc) => sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (
        ${name},
        ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
        ${sequence},
        ${DateTime.formatIso(at)}
      )
      ON CONFLICT(projection_name) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at
    `;

    // Collects anchors whose prompt later rows borrow through promptSequence.
    const readPromptReferences = Effect.fnUntraced(function* (
      afterSequence: number,
      throughSequence: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = new Set<number>();
      for (let cursor = afterSequence; cursor < throughSequence;) {
        const windowEnd = Math.min(cursor + REFERENCE_SCAN_WINDOW, throughSequence);
        const rows = yield* sql<{ readonly prompt_sequence: number }>`
          SELECT json_extract(payload_json, '$.promptSequence') AS prompt_sequence
          FROM orchestration_events
          WHERE sequence > ${cursor}
            AND sequence <= ${windowEnd}
            AND event_type IN ('subagent.updated', 'turn-item.updated')
            AND json_type(payload_json, '$.promptSequence') = 'integer'
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of rows) referenced.add(row.prompt_sequence);
        cursor = windowEnd;
        yield* betweenPages;
      }
      return referenced;
    });

    const pruneEvents = Effect.fnUntraced(function* (
      throughSequence: number,
      head: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = yield* readPromptReferences(throughSequence, head, betweenPages);
      // Stream heads at or below the boundary are kept, so the anchors they borrow must stay too.
      const keptHeadReferences = yield* sql<{ readonly prompt_sequence: number }>`
        SELECT json_extract(event.payload_json, '$.promptSequence') AS prompt_sequence
        FROM (
          SELECT MAX(sequence) AS sequence FROM orchestration_events
          GROUP BY aggregate_kind, stream_id
        ) AS heads
        JOIN orchestration_events AS event ON event.sequence = heads.sequence
        WHERE heads.sequence <= ${throughSequence}
          AND event.event_type IN ('subagent.updated', 'turn-item.updated')
          AND json_type(event.payload_json, '$.promptSequence') = 'integer'
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of keptHeadReferences) referenced.add(row.prompt_sequence);
      yield* betweenPages;
      let referencesThrough = head;
      let deleted = 0;
      let cursor = 0;
      while (cursor < throughSequence) {
        const rows = yield* sql<{ readonly sequence: number; readonly prunable: number }>`
          SELECT
            event.sequence,
            CASE
              WHEN event.application_event_version = 1 THEN 0
              -- The legacy importer treats a thread without thread.created as not yet imported.
              WHEN event.event_type = 'thread.created' THEN 0
              -- Codex usage history reads the selection a run attempt started with.
              WHEN event.event_type = 'run.updated'
                AND json_extract(event.payload_json, '$.status') = 'running' THEN 0
              -- The newest row keeps each stream's high water, stream_version, and snapshot sequence.
              WHEN event.sequence = (
                SELECT MAX(newer.sequence) FROM orchestration_events AS newer
                WHERE newer.aggregate_kind = event.aggregate_kind
                  AND newer.stream_id = event.stream_id
              ) THEN 0
              ELSE 1
            END AS prunable
          FROM orchestration_events AS event
          WHERE event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const candidates = rows.filter((row) => row.prunable === 1).map((row) => row.sequence);
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (candidates.length > 0) {
          deleted += yield* sql.withTransaction(
            Effect.gen(function* () {
              // Rows appended since the reference scan may borrow a prompt from a candidate.
              const appended = yield* sql<{
                readonly sequence: number;
                readonly prompt_sequence: number | null;
              }>`
                SELECT
                  sequence,
                  CASE
                    WHEN event_type IN ('subagent.updated', 'turn-item.updated')
                      AND json_type(payload_json, '$.promptSequence') = 'integer'
                    THEN json_extract(payload_json, '$.promptSequence')
                  END AS prompt_sequence
                FROM orchestration_events
                WHERE sequence > ${referencesThrough}
              `;
              for (const row of appended) {
                if (row.prompt_sequence !== null) referenced.add(row.prompt_sequence);
                referencesThrough = Math.max(referencesThrough, row.sequence);
              }
              const obsolete = candidates.filter((sequence) => !referenced.has(sequence));
              if (obsolete.length === 0) return 0;
              yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
              return obsolete.length;
            }),
          );
          yield* Effect.yieldNow;
        }
        // Rest after every page, including the last, so the next loop starts a fresh slice.
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.sequence ?? throughSequence;
      }
      return deleted;
    });

    // Imported legacy threads are served from v2 rows; their v1 events and receipts have no reader.
    const pruneImportedLegacyHistory = Effect.fnUntraced(function* (
      throughSequence: number,
      throughReceiptRowId: number,
      betweenPages: Effect.Effect<void>,
    ) {
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;
      for (let cursor = 0; ;) {
        const rows = yield* sql<{ readonly sequence: number; readonly imported: number }>`
          SELECT
            event.sequence,
            event.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = event.stream_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_events AS event
            INDEXED BY idx_orchestration_events_application_sequence
          WHERE event.application_event_version = 1
            AND event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.sequence);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.sequence ?? cursor;
      }
      for (let cursor = 0; ;) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = receipt.aggregate_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid > ${cursor} AND receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.row_id ?? cursor;
      }
      return { deletedEventCount, deletedReceiptCount };
    });

    // A run fork shows its source's history without copying it, through any chain of forks, and a
    // pending merge-back still reads its source. Such a deleted thread keeps its content until
    // every live thread that shows it is deleted too.
    const purgeableThreads = (deletedThreadId: ThreadId | undefined) =>
      sql<{
        readonly thread_id: string;
      }>`
      WITH RECURSIVE shown(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
        UNION
        SELECT transfer.source_thread_id
        FROM orchestration_v2_projection_context_transfers AS transfer
        JOIN orchestration_v2_projection_threads AS target
          ON target.thread_id = transfer.target_thread_id
        WHERE transfer.type = 'merge_back' AND transfer.status = 'pending'
          AND target.deleted_at IS NULL
        UNION
        SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
        FROM shown
        JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = shown.thread_id
        WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
      ),
      candidate(thread_id) AS (${
        deletedThreadId === undefined
          ? sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL`
          : // Deleting a fork can release the deleted sources it was the last to show.
            sql`
              SELECT ${deletedThreadId}
              UNION
              SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
              FROM candidate
              JOIN orchestration_v2_projection_threads AS fork
                ON fork.thread_id = candidate.thread_id
              WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
            `
      })
      SELECT thread.thread_id
      FROM candidate
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = candidate.thread_id
      WHERE thread.deleted_at IS NOT NULL
        AND thread.thread_id NOT IN (SELECT thread_id FROM shown WHERE thread_id IS NOT NULL)
        -- Earlier effects still read the thread; a later purge or sweep takes it.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = thread.thread_id
            AND effect.status IN ('pending', 'running')
            -- Title generation has its own lane and needs nothing the purge removes.
            AND effect.effect_type NOT IN ('thread-content.purge', 'thread-title.generate')
        )
        -- A live parent settles its delegated task from this child's runs.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents AS task
          JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = task.thread_id
          WHERE task.child_thread_id = thread.thread_id
            AND task.status IN ('idle', 'pending', 'running', 'waiting')
            AND parent.deleted_at IS NULL
        )
        -- The delete's own purge always runs; the sweep only takes threads with something left.
        AND ${
          deletedThreadId !== undefined
            ? sql`1 = 1`
            : sql.or([
                sql`thread.title <> ${DELETED_THREAD_TITLE}`,
                // A thread renamed to the placeholder still has its first title in thread.created.
                sql`EXISTS (
            SELECT 1 FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = thread.thread_id
              AND event_type IN ('thread.created', 'thread.deleted')
              AND json_extract(payload_json, '$.title') IS NOT ${DELETED_THREAD_TITLE}
          )`,
                sql`json_type(thread.payload_json, '$.guestShare') IS NOT NULL`,
                // An interrupted pass leaves events the purge does not keep.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_events
                    INDEXED BY idx_orchestration_events_agent_stream_sequence
                  WHERE application_event_version = 2
                    AND aggregate_kind = 'thread'
                    AND stream_id = thread.thread_id
                    AND event_type NOT IN ('thread.created', 'thread.deleted')
                    AND NOT (
                      event_type = 'run.updated'
                      AND json_extract(payload_json, '$.status') = 'running'
                    )
                )`,
                // The purge deletes settled requests and clears a failed one's error.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_v2_effect_outbox AS effect
                  WHERE effect.thread_id = thread.thread_id
                    AND effect.effect_type <> 'thread-content.purge'
                    AND (
                      effect.status IN ('succeeded', 'cancelled')
                      OR (effect.status = 'failed' AND effect.last_error IS NOT NULL)
                    )
                )`,
                ...DELETED_THREAD_CONTENT_TABLES.map(
                  (table) =>
                    sql`EXISTS (SELECT 1 FROM ${sql(table)} WHERE thread_id = thread.thread_id)`,
                ),
              ])
        }
    `.pipe(NodeSqliteClient.readOnly);

    const purgeThreads = Effect.fnUntraced(function* (
      deletedThreadId: ThreadId | undefined,
      betweenPages: Effect.Effect<void>,
    ) {
      const threads = yield* purgeableThreads(deletedThreadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      let purged = 0;
      // Each statement commits on its own, so a huge thread never holds the writer for long.
      const drain = Effect.fnUntraced(function* (
        deleteBatch: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      ) {
        for (;;) {
          const rows = yield* deleteBatch;
          purged += rows.length;
          yield* Effect.yieldNow;
          yield* betweenPages;
          if (rows.length < PURGE_BATCH_SIZE) return;
        }
      });
      for (const { thread_id: threadId } of threads) {
        // A re-import restores a deleted thread in one transaction, and each statement here
        // commits on its own, so each checks again that the thread is still deleted.
        const stillDeleted = sql`EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId} AND deleted_at IS NOT NULL
        )`;
        const tombstone = sql`(
          SELECT json_remove(json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}), '$.guestShare')
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        )`;
        yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_remove(
            json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}),
            '$.guestShare'
          )
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type IN ('thread.created', 'thread.deleted')
            AND ${stillDeleted}
        `;
        // The head row only holds the stream's position, so any other head becomes the tombstone.
        // First, so the head never borrows a prompt from an anchor already deleted below.
        yield* sql`
          UPDATE orchestration_events
          SET event_type = 'thread.deleted', payload_json = ${tombstone}, metadata_json = '{}'
          WHERE sequence = (
              SELECT MAX(sequence) FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            )
            AND event_type NOT IN ('thread.created', 'thread.deleted')
            AND NOT (
              event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
            )
            AND ${stillDeleted}
        `;
        for (const table of DELETED_THREAD_CONTENT_TABLES) {
          yield* drain(sql`
            DELETE FROM ${sql(table)}
            WHERE rowid IN (
              SELECT rowid FROM ${sql(table)} WHERE thread_id = ${threadId} LIMIT ${PURGE_BATCH_SIZE}
            )
              AND ${stillDeleted}
            RETURNING 1 AS purged
          `);
        }
        // Keep only what the pruner keeps for any stream: replay still delivers the deletion.
        yield* drain(sql`
          DELETE FROM orchestration_events
          WHERE sequence IN (
            SELECT sequence FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type NOT IN ('thread.created', 'thread.deleted')
              AND NOT (
                event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
              )
              AND sequence < (
                SELECT MAX(sequence) FROM orchestration_events
                WHERE application_event_version = 2
                  AND aggregate_kind = 'thread'
                  AND stream_id = ${threadId}
              )
            -- Newest first: a row borrowing its prompt goes before the anchor it borrows from.
            ORDER BY sequence DESC
            LIMIT ${PURGE_BATCH_SIZE}
          )
            AND ${stillDeleted}
          RETURNING 1 AS purged
        `);
        // Settled requests can hold answers, feedback, and titles. A failed one stays as the
        // marker that keeps a deleted thread's worktree, so only its text goes.
        yield* sql`
          DELETE FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND status IN ('succeeded', 'cancelled')
            AND ${stillDeleted}
        `;
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET payload_json = CASE
            WHEN json_type(payload_json, '$.title') = 'text'
              THEN json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE})
            ELSE json_remove(payload_json, '$.feedback', '$.answers')
          END,
            last_error = NULL
          WHERE thread_id = ${threadId} AND status = 'failed' AND ${stillDeleted}
        `;
        // Its v1 events then go with the imported-history prune, and no import refills it.
        yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET transcript_imported_at = ${now}
          WHERE thread_id = ${threadId} AND transcript_imported_at IS NULL AND ${stillDeleted}
        `;
        // Last, because the new title is what marks the purge as done.
        yield* sql`
          UPDATE projection_threads SET title = ${DELETED_THREAD_TITLE}
          WHERE thread_id = ${threadId} AND ${stillDeleted}
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET title = ${DELETED_THREAD_TITLE}, payload_json = ${tombstone}
          WHERE thread_id = ${threadId} AND deleted_at IS NOT NULL
        `;
      }
      return purged;
    });

    const purgeDeletedThread: ProjectionMaintenanceV2Shape["purgeDeletedThread"] = (threadId) =>
      purgeThreads(threadId, Effect.void).pipe(
        Effect.withSpan("ProjectionMaintenance.purgeDeletedThread"),
        Effect.mapError(
          (cause) => new ProjectionMaintenanceError({ operation: "purge deleted thread", cause }),
        ),
      );

    // A pass prunes through the mark the previous pass left once that mark is a day old, so
    // at least RETAINED_EVENT_HISTORY of events always remains. Receipts stay for idempotency.
    const pruneEventStore = Effect.fn("ProjectionMaintenance.pruneEventStore")(
      function* (betweenPages: Effect.Effect<void> = Effect.void) {
        const now = yield* DateTime.now;
        const metadata = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name IN (
            'thread-projections', ${EVENT_LOG_PRUNE_MARK}, ${EVENT_LOG_PRUNED_THROUGH}
          )
        `.pipe(NodeSqliteClient.readOnly);
        const read = (name: string) => metadata.find((row) => row.projection_name === name);
        const projected = read("thread-projections")?.last_sequence ?? 0;
        const mark = read(EVENT_LOG_PRUNE_MARK);
        const prunedThrough = read(EVENT_LOG_PRUNED_THROUGH)?.last_sequence ?? 0;
        // Fixed bounds: foreground commits during the pass wait for the next one.
        const bounds = yield* sql<{ readonly sequence: number; readonly receipt_row_id: number }>`
          SELECT
            COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS sequence,
            COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
        `.pipe(NodeSqliteClient.readOnly);
        const head = bounds[0]?.sequence ?? 0;

        let deletedEventCount = 0;
        const markIsDue =
          mark !== undefined &&
          DateTime.toEpochMillis(now) - Date.parse(mark.updated_at) >=
            Duration.toMillis(RETAINED_EVENT_HISTORY);
        if (mark !== undefined && markIsDue) {
          const throughSequence = Math.max(Math.min(mark.last_sequence, projected), prunedThrough);
          if (throughSequence > prunedThrough) {
            // Publish the boundary first so resuming clients take a snapshot, never a partial replay.
            yield* writeMetadata(EVENT_LOG_PRUNED_THROUGH, throughSequence, now);
          }
          deletedEventCount += yield* pruneEvents(throughSequence, head, betweenPages);
        }
        if (mark === undefined || markIsDue) yield* writeMetadata(EVENT_LOG_PRUNE_MARK, head, now);

        // Catches threads deleted before purging existed, and any purge a crash interrupted.
        // It runs first so the legacy prune below takes the v1 events of threads it marks.
        const purgedRowCount = yield* purgeThreads(undefined, betweenPages);

        const legacy = yield* pruneImportedLegacyHistory(
          head,
          bounds[0]?.receipt_row_id ?? 0,
          betweenPages,
        );
        deletedEventCount += legacy.deletedEventCount;

        const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        const reclaimableBytes =
          (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

        return {
          deletedEventCount,
          deletedReceiptCount: legacy.deletedReceiptCount,
          purgedRowCount,
          reclaimableBytes,
        };
      },
      Effect.mapError(
        (cause) => new ProjectionMaintenanceError({ operation: "prune event store", cause }),
      ),
    );

    return ProjectionMaintenanceV2.of({ pruneEventStore, purgeDeletedThread });
  }),
);
