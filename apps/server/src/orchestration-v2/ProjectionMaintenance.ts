import {
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2TurnItemJson,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { compactProviderHandoffSummary } from "./providerHandoffSummary.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
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

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

const decodeHandoff = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJson),
);
const decodeTurnItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

type SummaryRewrite = {
  readonly sequence: number;
  readonly threadId: string;
  readonly payloadJson: string;
  readonly id: string;
  readonly summary: string;
  readonly receipt: string;
  readonly strategy: string;
} & (
  | { readonly kind: "context" }
  | {
      readonly kind: "activity";
      readonly handoffId: string;
      readonly handoffPayloadJson: string;
    }
);

function summaryRewrite(row: {
  readonly sequence: number;
  readonly stream_id: string;
  readonly event_type: string;
  readonly compactable_payload_json: string | null;
  readonly handoff_payload_json: string | null;
}): SummaryRewrite | null {
  if (row.compactable_payload_json === null) return null;
  const common = {
    sequence: row.sequence,
    threadId: row.stream_id,
    payloadJson: row.compactable_payload_json,
  };
  if (row.event_type === "context-handoff.updated") {
    const decoded = decodeHandoff(row.compactable_payload_json);
    if (Option.isNone(decoded) || decoded.value.threadId !== row.stream_id) return null;
    const handoff = decoded.value;
    const receipt = compactProviderHandoffSummary(handoff, handoff.summaryText);
    return receipt === null
      ? null
      : {
          ...common,
          kind: "context",
          id: handoff.id,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
          receipt,
        };
  }
  if (row.event_type !== "turn-item.updated" || row.handoff_payload_json === null) return null;
  const decoded = decodeTurnItem(row.compactable_payload_json);
  const decodedHandoff = decodeHandoff(row.handoff_payload_json);
  if (Option.isNone(decoded) || Option.isNone(decodedHandoff)) return null;
  const item = decoded.value;
  const handoff = decodedHandoff.value;
  if (
    item.type !== "handoff" ||
    item.summary === undefined ||
    item.threadId !== row.stream_id ||
    handoff.threadId !== item.threadId ||
    handoff.id !== item.contextHandoffId ||
    handoff.strategy !== item.strategy ||
    handoff.toProviderThreadId !== item.toProviderThreadId
  ) {
    return null;
  }
  const receipt = compactProviderHandoffSummary(handoff, item.summary);
  return receipt === null
    ? null
    : {
        ...common,
        kind: "activity",
        id: item.id,
        strategy: item.strategy,
        summary: item.summary,
        receipt,
        handoffId: handoff.id,
        handoffPayloadJson: row.handoff_payload_json,
      };
}

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
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
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
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
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
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
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
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
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
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
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
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

    // Keep thread.created as the verification and replay anchor; clients recognize deletion by thread.deleted event type.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ];
    // Read-state events preserve updatedAt and supersede only each other. Activity events supersede both groups.
    const READ_STATE_THREAD_EVENT_TYPES = ["thread.visited", "thread.marked-unread"];
    // Older clients skip tag events, so these supersede only each other.
    const TAG_THREAD_EVENT_TYPE = "thread.tags-updated";

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    // Subagent snapshots stay intact because later rows can reference an earlier prompt.
    // Commanded turn items stay for command-result replay.
    // Small pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;

    // Keep first/latest keyed events for replay order; page every event to bound sparse scans.
    const compactEventStore = Effect.fn("ProjectionMaintenance.compactEventStore")(function* (
      betweenPages: Effect.Effect<void> = Effect.void,
    ) {
      const bounds = yield* sql<{
        readonly event_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `.pipe(NodeSqliteClient.readOnly);
      let throughSequence = bounds[0]?.event_sequence ?? 0;
      let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedReadStateThreadIds = new Set<string>();
      const retainedTagThreadIds = new Set<string>();
      // Retain each key's oldest candidate, deleting it only when an older event appears.
      const oldestCandidateByEntityKey = new Map<string, number | null>();
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;

      while (throughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly application_event_version: number;
          readonly aggregate_kind: string;
          readonly stream_id: string;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly imported_legacy_thread: number;
          readonly compactable_payload_json: string | null;
          readonly handoff_payload_json: string | null;
        }>`
          SELECT
            event.sequence,
            event.application_event_version,
            event.aggregate_kind,
            event.stream_id,
            event.event_type,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type IN ('message.updated', 'node.updated')
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'turn-item.updated'
                AND event.command_id IS NULL
                AND json_extract(event.payload_json, '$.type') <> 'subagent'
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'thread.pull-request-link-updated'
              THEN json_array(json_extract(event.payload_json, '$.host'),
                json_extract(event.payload_json, '$.repository'),
                json_extract(event.payload_json, '$.number'))
              ELSE NULL
            END AS entity_id,
            CASE
              WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread,
            CASE
              WHEN event.application_event_version = 2
                AND event.aggregate_kind = 'thread'
                AND json_extract(event.payload_json, '$.strategy')
                  IN ('delta_since_target_last_seen', 'full_thread_summary')
                AND (
                  (event.event_type = 'context-handoff.updated'
                    AND json_type(event.payload_json, '$.history.messages') = 'array')
                  OR (event.event_type = 'turn-item.updated'
                    AND json_extract(event.payload_json, '$.type') = 'handoff'
                    AND json_type(event.payload_json, '$.summary') = 'text')
                )
              THEN event.payload_json
              ELSE NULL
            END AS compactable_payload_json,
            handoff.payload_json AS handoff_payload_json
          FROM orchestration_events AS event
          LEFT JOIN orchestration_v2_projection_context_handoffs AS handoff
            ON event.application_event_version = 2
            AND event.event_type = 'turn-item.updated'
            AND json_extract(event.payload_json, '$.type') = 'handoff'
            AND json_extract(event.payload_json, '$.strategy')
              IN ('delta_since_target_last_seen', 'full_thread_summary')
            AND handoff.thread_id = event.stream_id
            AND handoff.context_handoff_id = json_extract(event.payload_json, '$.contextHandoffId')
          WHERE event.sequence <= ${throughSequence}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete: number[] = [];
        for (const row of page) {
          if (row.imported_legacy_thread === 1) {
            obsolete.push(row.sequence);
          } else if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              readStateThreadEventTypes.has(row.event_type)
            ) {
              if (
                retainedThreadIds.has(row.stream_id) ||
                retainedReadStateThreadIds.has(row.stream_id)
              ) {
                obsolete.push(row.sequence);
              } else retainedReadStateThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              row.event_type === TAG_THREAD_EVENT_TYPE
            ) {
              if (retainedThreadIds.has(row.stream_id) || retainedTagThreadIds.has(row.stream_id)) {
                obsolete.push(row.sequence);
              } else retainedTagThreadIds.add(row.stream_id);
            } else if (
              row.event_type === "thread.pull-request-link-updated" &&
              retainedThreadIds.has(row.stream_id)
            ) {
              // A newer whole-thread payload already carries this link's state.
              obsolete.push(row.sequence);
            } else if (
              row.event_type === "thread.pull-request-link-updated" ||
              row.event_type === "message.updated" ||
              row.event_type === "node.updated" ||
              (row.event_type === "turn-item.updated" && row.entity_id !== null)
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              const candidate = oldestCandidateByEntityKey.get(key);
              if (candidate === undefined) oldestCandidateByEntityKey.set(key, null);
              else {
                if (candidate !== null) obsolete.push(candidate);
                oldestCandidateByEntityKey.set(key, row.sequence);
              }
            }
          }
        }
        const obsoleteSequences = new Set(obsolete);
        const rewrites = page.flatMap((row) => {
          if (obsoleteSequences.has(row.sequence)) return [];
          const rewrite = summaryRewrite(row);
          return rewrite === null ? [] : [rewrite];
        });
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (obsolete.length > 0 || rewrites.length > 0) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (obsolete.length > 0) {
                yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
                deletedEventCount += obsolete.length;
              }
              for (const rewrite of rewrites) {
                const changed = yield* sql<{ readonly sequence: number }>`
                  UPDATE orchestration_events
                  SET payload_json = json_set(payload_json,
                    ${rewrite.kind === "context" ? "$.summaryText" : "$.summary"}, ${rewrite.receipt})
                  WHERE sequence = ${rewrite.sequence}
                    AND application_event_version = 2
                    AND aggregate_kind = 'thread'
                    AND stream_id = ${rewrite.threadId}
                    AND event_type = ${rewrite.kind === "context" ? "context-handoff.updated" : "turn-item.updated"}
                    AND payload_json = ${rewrite.payloadJson}
                    ${
                      rewrite.kind === "activity"
                        ? sql`AND EXISTS (
                            SELECT 1 FROM orchestration_v2_projection_context_handoffs AS source
                            WHERE source.context_handoff_id = ${rewrite.handoffId}
                              AND source.thread_id = ${rewrite.threadId}
                              AND source.strategy = ${rewrite.strategy}
                              AND json_extract(source.payload_json, '$.history') =
                                json_extract(${rewrite.handoffPayloadJson}, '$.history')
                          )`
                        : sql``
                    }
                  RETURNING sequence
                `;
                if (changed.length === 0) continue;
                if (rewrite.kind === "context") {
                  yield* sql`
                    UPDATE orchestration_v2_projection_context_handoffs
                    SET payload_json = json_set(payload_json, '$.summaryText', ${rewrite.receipt})
                    WHERE context_handoff_id = ${rewrite.id}
                      AND thread_id = ${rewrite.threadId}
                      AND strategy = ${rewrite.strategy}
                      AND json_extract(payload_json, '$.summaryText') = ${rewrite.summary}
                      AND json_extract(payload_json, '$.history') =
                        json_extract(${rewrite.payloadJson}, '$.history')
                  `;
                } else {
                  yield* sql`
                    UPDATE orchestration_v2_projection_turn_items
                    SET payload_json = json_set(payload_json, '$.summary', ${rewrite.receipt})
                    WHERE turn_item_id = ${rewrite.id}
                      AND thread_id = ${rewrite.threadId}
                      AND type = 'handoff'
                      AND json_extract(payload_json, '$.contextHandoffId') = ${rewrite.handoffId}
                      AND json_extract(payload_json, '$.strategy') = ${rewrite.strategy}
                      AND json_extract(payload_json, '$.summary') = ${rewrite.summary}
                  `;
                }
              }
            }),
          );
          yield* Effect.yieldNow;
        }
        throughSequence =
          rows.length <= COMPACTION_PAGE_SIZE ? 0 : (page.at(-1)?.sequence ?? 1) - 1;
        if (throughSequence > 0 || throughReceiptRowId > 0) yield* betweenPages;
      }

      while (throughReceiptRowId > 0) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            CASE
              WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = receipt.aggregate_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete = page
          .filter((row) => row.imported_legacy_thread === 1)
          .map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughReceiptRowId = (page.at(-1)?.row_id ?? 1) - 1;
        if (rows.length <= COMPACTION_PAGE_SIZE) break;
        yield* betweenPages;
      }

      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return { deletedEventCount, deletedReceiptCount, reclaimableBytes };
    }, mapError("compact event store"));

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore,
    });
  }),
);
