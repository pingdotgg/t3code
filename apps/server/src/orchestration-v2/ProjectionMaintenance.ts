import { type OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventStoreV2 } from "./EventStore.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "./ProjectionStore.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedErrorClass<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStoreV2 | ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStoreV2;
    const projectionStore = yield* ProjectionStoreV2;

    const readAllEvents = Effect.gen(function* () {
      const events: Array<OrchestrationV2StoredEvent> = [];
      const pageSize = 500;
      let afterSequence = 0;
      while (true) {
        const page = yield* eventStore.read({ afterSequence, limit: pageSize }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        events.push(...page);
        if (page.length < pageSize) {
          break;
        }
        afterSequence = page.at(-1)?.sequence ?? afterSequence;
      }
      return events;
    });

    /**
     * EventSink commits the event, its projection updates, and projection metadata in one SQL
     * transaction. Startup verification therefore checks that transaction boundary and that every
     * stored projection can be decoded. It intentionally does not replay domain events through a
     * second projector: doing so creates another implementation of projection semantics that must
     * evolve in lockstep with ProjectionStore.
     */
    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = (yield* Effect.forEach(
        actualIds,
        (threadId) =>
          projectionStore.getThreadProjection(threadId).pipe(
            Effect.as<ThreadId | null>(null),
            Effect.orElseSucceed((): ThreadId | null => threadId),
          ),
        { concurrency: 8 },
      )).filter((threadId): threadId is ThreadId => threadId !== null);
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    });

    const rebuild = Effect.gen(function* () {
      const events = yield* readAllEvents;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagent_activations`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          for (const stored of events) {
            yield* projectionStore.apply(stored.event);
            if (stored.event.type === "turn-item.updated") {
              yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
              `;
            }
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const lastSequence = events.at(-1)?.sequence ?? 0;
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Thread-state events whose payload is the complete thread: only the
    // newest per thread can influence a replay or an afterSequence catch-up.
    // thread.created stays out — verify derives the expected thread set from
    // it, and it anchors replay ordering.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.metadata-updated",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.visited",
      "thread.marked-unread",
    ];

    const chunksOf = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
      const out: Array<ReadonlyArray<A>> = [];
      for (let index = 0; index < items.length; index += size) {
        out.push(items.slice(index, index + size));
      }
      return out;
    };

    // The sqlite driver is synchronous: one statement over millions of rows
    // would pin the event loop for its whole duration. Small auto-committed
    // batches with a yield between them keep the server responsive and bound
    // WAL growth; each batch is independently durable, so a crash mid-way
    // just leaves less garbage for the next run.
    const COMPACTION_DELETE_BATCH_SIZE = 2_000;
    const deleteRowsBatched = (input: {
      readonly table: "orchestration_events" | "orchestration_command_receipts";
      readonly keys: ReadonlyArray<number | string>;
    }) =>
      Effect.gen(function* () {
        let deleted = 0;
        for (const batch of chunksOf(input.keys, COMPACTION_DELETE_BATCH_SIZE)) {
          if (input.table === "orchestration_events") {
            yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(batch)}`;
          } else {
            yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(batch)}`;
          }
          deleted += batch.length;
          yield* Effect.yieldNow;
        }
        return deleted;
      });

    /**
     * Full event-store compaction. Projections are the working state (startup
     * verifies rather than replays), so events only serve afterSequence
     * catch-up and disaster-recovery rebuild — and for full-payload "state of
     * the entity" events, anything but the newest per entity is dead weight
     * in both. Three passes:
     *
     * 1. Superseded thread-state events (visits alone accumulate at multiple
     *    per minute while a thread is open).
     * 2. Superseded message.updated / node.updated events per entity id —
     *    streaming rewrites the same message many times. turn-item.updated is
     *    deliberately NOT compacted: rebuild derives turn_item_positions from
     *    those events with first-write-wins semantics, so keep-latest would
     *    change replay outcomes for reordered items.
     * 3. Legacy v1 thread events and their pre-migration command receipts for
     *    threads whose v2 import completed — the v1 store is only read to
     *    import from, and imports never re-run once transcript_imported_at is
     *    set.
     *
     * VACUUM is deliberately not run here: on the synchronous driver it would
     * block every query for minutes on a multi-GB file. The reclaimable page
     * count is reported so the caller can surface a hint instead; freed pages
     * are reused, so the file stops growing either way.
     */
    const compactEventStore = Effect.gen(function* () {
      const supersededThreadStateRows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type IN ${sql.in(SUPERSEDABLE_THREAD_EVENT_TYPES)}
          AND sequence NOT IN (
            SELECT MAX(sequence)
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND event_type IN ${sql.in(SUPERSEDABLE_THREAD_EVENT_TYPES)}
            GROUP BY stream_id
          )
      `;

      const supersededEntityRows = (eventType: "message.updated" | "node.updated") => sql<{
        readonly sequence: number;
      }>`
        SELECT sequence
        FROM orchestration_events
        WHERE application_event_version = 2
          AND event_type = ${eventType}
          AND sequence NOT IN (
            SELECT MAX(sequence)
            FROM orchestration_events
            WHERE application_event_version = 2
              AND event_type = ${eventType}
            GROUP BY stream_id, json_extract(payload_json, '$.id')
          )
      `;
      const supersededMessageRows = yield* supersededEntityRows("message.updated");
      const supersededNodeRows = yield* supersededEntityRows("node.updated");

      const importedLegacyEventRows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE application_event_version = 1
          AND aggregate_kind = 'thread'
          AND stream_id IN (
            SELECT thread_id
            FROM orchestration_v2_legacy_imports
            WHERE transcript_imported_at IS NOT NULL
          )
      `;

      const deletedEventCount = yield* deleteRowsBatched({
        table: "orchestration_events",
        keys: [
          ...supersededThreadStateRows,
          ...supersededMessageRows,
          ...supersededNodeRows,
          ...importedLegacyEventRows,
        ].map((row) => row.sequence),
      });

      // Receipts written before the command_type column existed default to
      // 'legacy'; for fully imported v1 threads they guard idempotency of
      // commands that can no longer be re-sent.
      const legacyReceiptRows = yield* sql<{ readonly command_id: string }>`
        SELECT command_id
        FROM orchestration_command_receipts
        WHERE command_type = 'legacy'
          AND aggregate_kind = 'thread'
          AND aggregate_id IN (
            SELECT thread_id
            FROM orchestration_v2_legacy_imports
            WHERE transcript_imported_at IS NOT NULL
          )
      `;
      const deletedReceiptCount = yield* deleteRowsBatched({
        table: "orchestration_command_receipts",
        keys: legacyReceiptRows.map((row) => row.command_id),
      });

      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return { deletedEventCount, deletedReceiptCount, reclaimableBytes };
    });

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore: mapError("compact event store")(compactEventStore),
    });
  }),
);
