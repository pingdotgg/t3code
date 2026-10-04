import {
  PullRequestMonitorError,
  type PullRequestMonitorActionableEventKind,
  type PullRequestMonitorFeedbackDelivery,
  type PullRequestMonitorFeedbackDeliveryId,
  type PullRequestMonitorFeedbackDeliveryStatus,
  type PullRequestMonitorFeedbackDisposition,
  type PullRequestMonitorFeedbackActorRole,
  type PullRequestMonitorFeedbackOrigin,
  type PullRequestMonitorFeedbackItem,
  type PullRequestMonitorFeedbackItemId,
  type PullRequestMonitorFeedbackItemStatus,
  type PullRequestMonitorFeedbackReport,
  type PullRequestMonitorFeedbackRevision,
  type PullRequestMonitorFeedbackRevisionId,
  type PullRequestMonitorId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeStringArray = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const isPullRequestMonitorError = Schema.is(PullRequestMonitorError);

function storeError(message: string, cause?: unknown) {
  return new PullRequestMonitorError({ message, cause });
}

interface ItemRow {
  readonly item_id: string;
  readonly monitor_id: string;
  readonly stable_key: string;
  readonly kind: string;
  readonly status: string;
  readonly disposition: string | null;
  readonly disposition_note: string | null;
  readonly disposition_at: string | null;
  readonly disposition_by_thread_id: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly current_revision_id: string | null;
  readonly summary: string | null;
  readonly current_head_sha: string | null;
  readonly origin: string | null;
  readonly origin_thread_id: string | null;
  readonly child_disposition: string | null;
  readonly reviewer_disposition: string | null;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly monitor_id: string;
  readonly batch_key: string;
  readonly target_thread_id: string;
  readonly command_id: string;
  readonly message_id: string;
  readonly revision_ids_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly next_attempt_at: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly receipt_json: string | null;
}

interface ReportRow {
  readonly report_id: string;
  readonly monitor_id: string;
  readonly item_id: string;
  readonly disposition: string;
  readonly note: string | null;
  readonly reporter_thread_id: string | null;
  readonly created_at: string;
  readonly actor_role: string | null;
}

interface StateRow {
  readonly monitor_id: string;
  readonly pending_revision_ids_json: string;
  readonly debounce_until: string | null;
  readonly delivery_failure_count: number;
  readonly circuit_open_until: string | null;
  readonly updated_at: string;
}

export interface FeedbackMonitorState {
  readonly monitorId: PullRequestMonitorId;
  readonly pendingRevisionIds: ReadonlyArray<string>;
  readonly debounceUntil: string | null;
  readonly deliveryFailureCount: number;
  readonly circuitOpenUntil: string | null;
  readonly updatedAt: string;
}

function rowToItem(row: ItemRow): PullRequestMonitorFeedbackItem {
  return {
    id: row.item_id as PullRequestMonitorFeedbackItemId,
    monitorId: row.monitor_id as PullRequestMonitorId,
    stableKey: row.stable_key,
    kind: row.kind as PullRequestMonitorActionableEventKind,
    status: row.status as PullRequestMonitorFeedbackItem["status"],
    disposition: row.disposition as PullRequestMonitorFeedbackDisposition | null,
    dispositionNote: row.disposition_note,
    dispositionAt: row.disposition_at,
    dispositionByThreadId: row.disposition_by_thread_id as ThreadId | null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    currentRevisionId: row.current_revision_id as PullRequestMonitorFeedbackRevisionId | null,
    currentRevisionHeadSha: row.current_head_sha,
    summary: (row.summary ?? "").slice(0, 500),
    origin: (row.origin ?? "provider") as PullRequestMonitorFeedbackOrigin,
    originThreadId: row.origin_thread_id as ThreadId | null,
    childDisposition: row.child_disposition as PullRequestMonitorFeedbackItem["childDisposition"],
    reviewerDisposition:
      row.reviewer_disposition as PullRequestMonitorFeedbackItem["reviewerDisposition"],
  };
}

function rowToDelivery(
  row: DeliveryRow,
): Effect.Effect<PullRequestMonitorFeedbackDelivery, PullRequestMonitorError> {
  return Effect.gen(function* () {
    const revisionIds = yield* decodeStringArray(row.revision_ids_json).pipe(
      Effect.mapError((cause) => storeError("Could not decode delivery revision ids.", cause)),
    );
    return {
      id: row.delivery_id as PullRequestMonitorFeedbackDeliveryId,
      monitorId: row.monitor_id as PullRequestMonitorId,
      batchKey: row.batch_key,
      targetThreadId: row.target_thread_id as ThreadId,
      commandId: row.command_id,
      messageId: row.message_id,
      revisionIds: revisionIds as ReadonlyArray<PullRequestMonitorFeedbackRevisionId>,
      status: row.status as PullRequestMonitorFeedbackDeliveryStatus,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
    };
  });
}

function rowToReport(row: ReportRow): PullRequestMonitorFeedbackReport {
  return {
    id: row.report_id,
    monitorId: row.monitor_id as PullRequestMonitorId,
    itemId: row.item_id as PullRequestMonitorFeedbackItemId,
    disposition: row.disposition as PullRequestMonitorFeedbackDisposition,
    note: row.note,
    reporterThreadId: row.reporter_thread_id as ThreadId | null,
    createdAt: row.created_at,
    actorRole: row.actor_role as PullRequestMonitorFeedbackActorRole,
  };
}

export interface PullRequestMonitorFeedbackStoreApi {
  readonly upsertOpenItem: (input: {
    readonly item: Omit<
      PullRequestMonitorFeedbackItem,
      "summary" | "currentRevisionId" | "currentRevisionHeadSha"
    > & {
      readonly currentRevisionId: PullRequestMonitorFeedbackRevisionId | null;
      readonly summary: string;
      readonly origin?: PullRequestMonitorFeedbackOrigin | undefined;
      readonly originThreadId?: ThreadId | null | undefined;
      readonly childDisposition?: PullRequestMonitorFeedbackItem["childDisposition"] | undefined;
      readonly reviewerDisposition?:
        | PullRequestMonitorFeedbackItem["reviewerDisposition"]
        | undefined;
    };
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly insertRevision: (
    revision: Omit<PullRequestMonitorFeedbackRevision, "payload"> & { readonly payload: unknown },
  ) => Effect.Effect<boolean, PullRequestMonitorError>;
  /** Source-content identity lookup; a hit means this observation was already ingested. */
  readonly findRevisionByIdentity: (input: {
    readonly itemId: PullRequestMonitorFeedbackItemId;
    readonly sourceRevision: string;
    readonly contentHash: string;
  }) => Effect.Effect<PullRequestMonitorFeedbackRevisionId | null, PullRequestMonitorError>;
  readonly listRevisionsByIds: (
    revisionIds: ReadonlyArray<PullRequestMonitorFeedbackRevisionId | string>,
  ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackRevision>, PullRequestMonitorError>;
  readonly getItem: (
    itemId: PullRequestMonitorFeedbackItemId,
  ) => Effect.Effect<PullRequestMonitorFeedbackItem | null, PullRequestMonitorError>;
  readonly listItems: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly includeClosed?: boolean;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackItem>, PullRequestMonitorError>;
  readonly setDisposition: (input: {
    readonly itemId: PullRequestMonitorFeedbackItemId;
    readonly disposition: PullRequestMonitorFeedbackDisposition;
    readonly note: string | null;
    readonly at: string;
    readonly byThreadId: ThreadId | null;
    readonly status: PullRequestMonitorFeedbackItemStatus;
    readonly childDisposition?: PullRequestMonitorFeedbackItem["childDisposition"] | undefined;
    readonly reviewerDisposition?:
      | PullRequestMonitorFeedbackItem["reviewerDisposition"]
      | undefined;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly insertReport: (
    report: PullRequestMonitorFeedbackReport,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  /** Atomically apply disposition + durable audit report row. */
  readonly reportDisposition: (input: {
    readonly itemId: PullRequestMonitorFeedbackItemId;
    readonly disposition: PullRequestMonitorFeedbackDisposition;
    readonly note: string | null;
    readonly at: string;
    readonly byThreadId: ThreadId | null;
    readonly status: PullRequestMonitorFeedbackItemStatus;
    readonly childDisposition?: PullRequestMonitorFeedbackItem["childDisposition"] | undefined;
    readonly reviewerDisposition?:
      | PullRequestMonitorFeedbackItem["reviewerDisposition"]
      | undefined;
    readonly report: PullRequestMonitorFeedbackReport;
    readonly actorRole?: PullRequestMonitorFeedbackActorRole;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly listReports: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackReport>, PullRequestMonitorError>;
  readonly getState: (
    monitorId: PullRequestMonitorId,
  ) => Effect.Effect<FeedbackMonitorState, PullRequestMonitorError>;
  /** Atomically union revision ids into pending without clobbering circuit fields. */
  readonly appendPendingRevisionIds: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly revisionIds: ReadonlyArray<string>;
    readonly debounceUntil: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  /** Atomically remove specific pending revision ids (and clear debounce when empty). */
  readonly removePendingRevisionIds: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly revisionIds: ReadonlyArray<string>;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  /** Atomically update only delivery-circuit columns. */
  readonly setDeliveryCircuitState: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly deliveryFailureCount: number;
    readonly circuitOpenUntil: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly insertDelivery: (
    delivery: PullRequestMonitorFeedbackDelivery & {
      readonly nextAttemptAt: string | null;
      readonly receiptJson: string | null;
    },
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly updateDelivery: (
    delivery: PullRequestMonitorFeedbackDelivery & {
      readonly nextAttemptAt: string | null;
      readonly receiptJson: string | null;
    },
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly getDelivery: (
    deliveryId: PullRequestMonitorFeedbackDeliveryId,
  ) => Effect.Effect<PullRequestMonitorFeedbackDelivery | null, PullRequestMonitorError>;
  readonly getDeliveryByBatchKey: (
    batchKey: string,
  ) => Effect.Effect<PullRequestMonitorFeedbackDelivery | null, PullRequestMonitorError>;
  readonly listDeliveries: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackDelivery>, PullRequestMonitorError>;
  readonly listDueDeliveries: (
    nowIso: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackDelivery>, PullRequestMonitorError>;
  readonly nextRevisionNumber: (
    itemId: PullRequestMonitorFeedbackItemId,
  ) => Effect.Effect<number, PullRequestMonitorError>;
}

export const PullRequestMonitorFeedbackStore = {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const getItem: PullRequestMonitorFeedbackStoreApi["getItem"] = (itemId) =>
      sql<ItemRow>`
        SELECT i.*, (
          SELECT r.summary FROM pull_request_monitor_feedback_revisions r
          WHERE r.revision_id = i.current_revision_id
        ) AS summary, (
          SELECT r.head_sha FROM pull_request_monitor_feedback_revisions r
          WHERE r.revision_id = i.current_revision_id
        ) AS current_head_sha
        FROM pull_request_monitor_feedback_items i
        WHERE i.item_id = ${itemId}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => (rows[0] ? rowToItem(rows[0]) : null)),
        Effect.mapError((cause) => storeError("Failed to load feedback item.", cause)),
      );

    const listItems: PullRequestMonitorFeedbackStoreApi["listItems"] = (input) =>
      Effect.gen(function* () {
        const rows = input.includeClosed
          ? yield* sql<ItemRow>`
              SELECT i.*, (
                SELECT r.summary FROM pull_request_monitor_feedback_revisions r
                WHERE r.revision_id = i.current_revision_id
              ) AS summary, (
                SELECT r.head_sha FROM pull_request_monitor_feedback_revisions r
                WHERE r.revision_id = i.current_revision_id
              ) AS current_head_sha
              FROM pull_request_monitor_feedback_items i
              WHERE i.monitor_id = ${input.monitorId}
              ORDER BY i.last_seen_at DESC
            `
          : yield* sql<ItemRow>`
              SELECT i.*, (
                SELECT r.summary FROM pull_request_monitor_feedback_revisions r
                WHERE r.revision_id = i.current_revision_id
              ) AS summary, (
                SELECT r.head_sha FROM pull_request_monitor_feedback_revisions r
                WHERE r.revision_id = i.current_revision_id
              ) AS current_head_sha
              FROM pull_request_monitor_feedback_items i
              WHERE i.monitor_id = ${input.monitorId} AND i.status <> 'closed'
              ORDER BY i.last_seen_at DESC
            `;
        return rows.map(rowToItem);
      }).pipe(Effect.mapError((cause) => storeError("Failed to list feedback items.", cause)));

    const upsertOpenItem: PullRequestMonitorFeedbackStoreApi["upsertOpenItem"] = ({ item }) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_items (
          item_id, monitor_id, stable_key, kind, status, disposition, disposition_note,
          disposition_at, disposition_by_thread_id, first_seen_at, last_seen_at, current_revision_id,
          origin, origin_thread_id, child_disposition, reviewer_disposition
        ) VALUES (
          ${item.id}, ${item.monitorId}, ${item.stableKey}, ${item.kind}, ${item.status},
          ${item.disposition}, ${item.dispositionNote}, ${item.dispositionAt},
          ${item.dispositionByThreadId}, ${item.firstSeenAt}, ${item.lastSeenAt},
          ${item.currentRevisionId}, ${item.origin ?? "provider"}, ${item.originThreadId ?? null},
          ${item.childDisposition ?? null}, ${item.reviewerDisposition ?? null}
        )
        ON CONFLICT(monitor_id, stable_key) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          disposition = excluded.disposition,
          disposition_note = excluded.disposition_note,
          disposition_at = excluded.disposition_at,
          disposition_by_thread_id = excluded.disposition_by_thread_id,
          last_seen_at = excluded.last_seen_at,
          current_revision_id = COALESCE(excluded.current_revision_id, pull_request_monitor_feedback_items.current_revision_id),
          origin = COALESCE(excluded.origin, pull_request_monitor_feedback_items.origin),
          origin_thread_id = COALESCE(excluded.origin_thread_id, pull_request_monitor_feedback_items.origin_thread_id),
          child_disposition = COALESCE(excluded.child_disposition, pull_request_monitor_feedback_items.child_disposition),
          reviewer_disposition = COALESCE(excluded.reviewer_disposition, pull_request_monitor_feedback_items.reviewer_disposition)
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to upsert feedback item.", cause)),
        Effect.asVoid,
      );

    const findRevisionByIdentity: PullRequestMonitorFeedbackStoreApi["findRevisionByIdentity"] = (
      input,
    ) =>
      sql<{ readonly revision_id: string }>`
        SELECT revision_id FROM pull_request_monitor_feedback_revisions
        WHERE item_id = ${input.itemId}
          AND source_revision = ${input.sourceRevision}
          AND content_hash = ${input.contentHash}
        LIMIT 1
      `.pipe(
        Effect.map(
          (rows) =>
            (rows[0]?.revision_id as PullRequestMonitorFeedbackRevisionId | undefined) ?? null,
        ),
        Effect.mapError((cause) => storeError("Failed to look up feedback revision.", cause)),
      );

    /**
     * Replay-safe: identity is the observed source content, so re-ingesting the same
     * observation is ignored rather than queued again as a new revision.
     */
    const insertRevision: PullRequestMonitorFeedbackStoreApi["insertRevision"] = (revision) =>
      Effect.gen(function* () {
        const existing = yield* findRevisionByIdentity({
          itemId: revision.itemId,
          sourceRevision: revision.sourceRevision,
          contentHash: revision.contentHash,
        });
        if (existing !== null) return false;
        yield* sql`
          INSERT INTO pull_request_monitor_feedback_revisions (
            revision_id, item_id, revision_number, payload_json, source_revision, content_hash,
            head_sha, created_at, summary
          ) VALUES (
            ${revision.id}, ${revision.itemId}, ${revision.revisionNumber},
            ${JSON.stringify(revision.payload)}, ${revision.sourceRevision}, ${revision.contentHash},
            ${revision.headSha}, ${revision.createdAt}, ${revision.summary}
          )
          ON CONFLICT DO NOTHING
        `;
        yield* sql`
          UPDATE pull_request_monitor_feedback_items
          SET current_revision_id = ${revision.id}, last_seen_at = ${revision.createdAt}
          WHERE item_id = ${revision.itemId}
        `;
        return true;
      }).pipe(
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause)
            ? cause
            : storeError("Failed to insert feedback revision.", cause),
        ),
      );

    const listRevisionsByIds: PullRequestMonitorFeedbackStoreApi["listRevisionsByIds"] = (
      revisionIds,
    ) => {
      if (revisionIds.length === 0) {
        return Effect.succeed([]);
      }
      const idsJson = JSON.stringify([...revisionIds]);
      return sql<{
        readonly revision_id: string;
        readonly item_id: string;
        readonly revision_number: number;
        readonly payload_json: string;
        readonly source_revision: string;
        readonly content_hash: string | null;
        readonly head_sha: string;
        readonly created_at: string;
        readonly summary: string | null;
      }>`
        SELECT revision_id, item_id, revision_number, payload_json, source_revision, content_hash, head_sha, created_at, summary
        FROM pull_request_monitor_feedback_revisions
        WHERE revision_id IN (SELECT value FROM json_each(${idsJson}))
        ORDER BY created_at ASC
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => {
            let payload: unknown = null;
            try {
              payload = JSON.parse(row.payload_json) as unknown;
            } catch {
              payload = { raw: row.payload_json.slice(0, 500) };
            }
            return {
              id: row.revision_id as PullRequestMonitorFeedbackRevisionId,
              itemId: row.item_id as PullRequestMonitorFeedbackItemId,
              revisionNumber: row.revision_number,
              sourceRevision: row.source_revision,
              contentHash: row.content_hash ?? row.revision_id,
              headSha: row.head_sha,
              createdAt: row.created_at,
              summary: (row.summary ?? "").slice(0, 500),
              payload,
            } satisfies PullRequestMonitorFeedbackRevision;
          }),
        ),
        Effect.mapError((cause) => storeError("Failed to load feedback revisions.", cause)),
      );
    };

    const setDisposition: PullRequestMonitorFeedbackStoreApi["setDisposition"] = (input) =>
      sql`
        UPDATE pull_request_monitor_feedback_items
        SET disposition = ${input.disposition},
            disposition_note = ${input.note},
            disposition_at = ${input.at},
            disposition_by_thread_id = ${input.byThreadId},
            status = ${input.status},
            child_disposition = COALESCE(${input.childDisposition ?? null}, child_disposition),
            reviewer_disposition = COALESCE(${input.reviewerDisposition ?? null}, reviewer_disposition)
        WHERE item_id = ${input.itemId}
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to set feedback disposition.", cause)),
        Effect.asVoid,
      );

    const insertReport: PullRequestMonitorFeedbackStoreApi["insertReport"] = (report) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_reports (
          report_id, monitor_id, item_id, disposition, note, reporter_thread_id, created_at,
          recheck_requested, actor_role
        ) VALUES (
          ${report.id}, ${report.monitorId}, ${report.itemId}, ${report.disposition},
          ${report.note}, ${report.reporterThreadId}, ${report.createdAt}, 1,
          ${report.actorRole ?? "provider"}
        )
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to insert feedback report.", cause)),
        Effect.asVoid,
      );

    const reportDisposition: PullRequestMonitorFeedbackStoreApi["reportDisposition"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE pull_request_monitor_feedback_items
              SET disposition = ${input.disposition},
                  disposition_note = ${input.note},
                  disposition_at = ${input.at},
                  disposition_by_thread_id = ${input.byThreadId},
                  status = ${input.status},
                  child_disposition = COALESCE(${input.childDisposition ?? null}, child_disposition),
                  reviewer_disposition = COALESCE(${input.reviewerDisposition ?? null}, reviewer_disposition)
              WHERE item_id = ${input.itemId}
            `;
            yield* sql`
              INSERT INTO pull_request_monitor_feedback_reports (
                report_id, monitor_id, item_id, disposition, note, reporter_thread_id, created_at,
                recheck_requested, actor_role
              ) VALUES (
                ${input.report.id}, ${input.report.monitorId}, ${input.report.itemId}, ${input.report.disposition},
                ${input.report.note}, ${input.report.reporterThreadId}, ${input.report.createdAt}, 1,
                ${input.actorRole ?? "provider"}
              )
            `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            storeError("Failed to commit feedback disposition report.", cause),
          ),
          Effect.asVoid,
        );

    const listReports: PullRequestMonitorFeedbackStoreApi["listReports"] = (input) =>
      sql<ReportRow>`
        SELECT * FROM pull_request_monitor_feedback_reports
        WHERE monitor_id = ${input.monitorId}
        ORDER BY created_at DESC
        LIMIT ${input.limit ?? 20}
      `.pipe(
        Effect.map((rows) => rows.map(rowToReport)),
        Effect.mapError((cause) => storeError("Failed to list feedback reports.", cause)),
      );

    const getState: PullRequestMonitorFeedbackStoreApi["getState"] = (monitorId) =>
      Effect.gen(function* () {
        const rows = yield* sql<StateRow>`
          SELECT * FROM pull_request_monitor_feedback_state WHERE monitor_id = ${monitorId} LIMIT 1
        `;
        const row = rows[0];
        if (!row) {
          return {
            monitorId,
            pendingRevisionIds: [],
            debounceUntil: null,
            deliveryFailureCount: 0,
            circuitOpenUntil: null,
            updatedAt: "1970-01-01T00:00:00.000Z",
          } satisfies FeedbackMonitorState;
        }
        const pending = yield* decodeStringArray(row.pending_revision_ids_json).pipe(
          Effect.mapError((cause) => storeError("Could not decode pending revisions.", cause)),
        );
        return {
          monitorId,
          pendingRevisionIds: pending,
          debounceUntil: row.debounce_until,
          deliveryFailureCount: row.delivery_failure_count,
          circuitOpenUntil: row.circuit_open_until,
          updatedAt: row.updated_at,
        } satisfies FeedbackMonitorState;
      }).pipe(
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause)
            ? cause
            : storeError("Failed to load feedback state.", cause),
        ),
      );

    const appendPendingRevisionIds: PullRequestMonitorFeedbackStoreApi["appendPendingRevisionIds"] =
      (input) =>
        sql`
        INSERT INTO pull_request_monitor_feedback_state (
          monitor_id, pending_revision_ids_json, debounce_until, delivery_failure_count,
          circuit_open_until, updated_at
        ) VALUES (
          ${input.monitorId}, ${JSON.stringify(input.revisionIds)}, ${input.debounceUntil},
          0, NULL, ${input.updatedAt}
        )
        ON CONFLICT(monitor_id) DO UPDATE SET
          pending_revision_ids_json = (
            SELECT json_group_array(value)
            FROM (
              SELECT value
              FROM json_each(pull_request_monitor_feedback_state.pending_revision_ids_json)
              UNION
              SELECT value
              FROM json_each(excluded.pending_revision_ids_json)
            )
          ),
          debounce_until = excluded.debounce_until,
          updated_at = excluded.updated_at
      `.pipe(
          Effect.mapError((cause) =>
            storeError("Failed to append pending feedback revisions.", cause),
          ),
          Effect.asVoid,
        );

    const removePendingRevisionIds: PullRequestMonitorFeedbackStoreApi["removePendingRevisionIds"] =
      (input) =>
        sql`
        UPDATE pull_request_monitor_feedback_state
        SET pending_revision_ids_json = (
              SELECT COALESCE(json_group_array(value), '[]')
              FROM json_each(pending_revision_ids_json)
              WHERE value NOT IN (SELECT value FROM json_each(${JSON.stringify(input.revisionIds)}))
            ),
            debounce_until = CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM json_each(pending_revision_ids_json)
                WHERE value NOT IN (SELECT value FROM json_each(${JSON.stringify(input.revisionIds)}))
              ) THEN NULL
              ELSE debounce_until
            END,
            updated_at = ${input.updatedAt}
        WHERE monitor_id = ${input.monitorId}
      `.pipe(
          Effect.mapError((cause) =>
            storeError("Failed to remove pending feedback revisions.", cause),
          ),
          Effect.asVoid,
        );

    const setDeliveryCircuitState: PullRequestMonitorFeedbackStoreApi["setDeliveryCircuitState"] = (
      input,
    ) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_state (
          monitor_id, pending_revision_ids_json, debounce_until, delivery_failure_count,
          circuit_open_until, updated_at
        ) VALUES (
          ${input.monitorId}, '[]', NULL, ${input.deliveryFailureCount},
          ${input.circuitOpenUntil}, ${input.updatedAt}
        )
        ON CONFLICT(monitor_id) DO UPDATE SET
          delivery_failure_count = excluded.delivery_failure_count,
          circuit_open_until = excluded.circuit_open_until,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.mapError((cause) =>
          storeError("Failed to update feedback delivery circuit.", cause),
        ),
        Effect.asVoid,
      );

    const insertDelivery: PullRequestMonitorFeedbackStoreApi["insertDelivery"] = (delivery) =>
      sql`
        INSERT INTO pull_request_monitor_feedback_deliveries (
          delivery_id, monitor_id, batch_key, target_thread_id, command_id, message_id,
          revision_ids_json, status, attempt_count, last_error, next_attempt_at, created_at,
          delivered_at, receipt_json
        ) VALUES (
          ${delivery.id}, ${delivery.monitorId}, ${delivery.batchKey}, ${delivery.targetThreadId},
          ${delivery.commandId}, ${delivery.messageId}, ${JSON.stringify(delivery.revisionIds)},
          ${delivery.status}, ${delivery.attemptCount}, ${delivery.lastError}, ${delivery.nextAttemptAt},
          ${delivery.createdAt}, ${delivery.deliveredAt}, ${delivery.receiptJson}
        )
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to insert delivery.", cause)),
        Effect.asVoid,
      );

    const updateDelivery: PullRequestMonitorFeedbackStoreApi["updateDelivery"] = (delivery) =>
      sql`
        UPDATE pull_request_monitor_feedback_deliveries
        SET target_thread_id = ${delivery.targetThreadId},
            command_id = ${delivery.commandId},
            message_id = ${delivery.messageId},
            status = ${delivery.status},
            attempt_count = ${delivery.attemptCount},
            last_error = ${delivery.lastError},
            next_attempt_at = ${delivery.nextAttemptAt},
            delivered_at = ${delivery.deliveredAt},
            receipt_json = ${delivery.receiptJson}
        WHERE delivery_id = ${delivery.id}
      `.pipe(
        Effect.mapError((cause) => storeError("Failed to update delivery.", cause)),
        Effect.asVoid,
      );

    const getDelivery: PullRequestMonitorFeedbackStoreApi["getDelivery"] = (deliveryId) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries
        WHERE delivery_id = ${deliveryId}
        LIMIT 1
      `.pipe(
        Effect.flatMap((rows) => (rows[0] ? rowToDelivery(rows[0]) : Effect.succeed(null))),
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause) ? cause : storeError("Failed to load delivery.", cause),
        ),
      );

    const getDeliveryByBatchKey: PullRequestMonitorFeedbackStoreApi["getDeliveryByBatchKey"] = (
      batchKey,
    ) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries WHERE batch_key = ${batchKey} LIMIT 1
      `.pipe(
        Effect.flatMap((rows) => (rows[0] ? rowToDelivery(rows[0]) : Effect.succeed(null))),
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause)
            ? cause
            : storeError("Failed to load delivery by batch key.", cause),
        ),
      );

    const listDeliveries: PullRequestMonitorFeedbackStoreApi["listDeliveries"] = (input) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries
        WHERE monitor_id = ${input.monitorId}
        ORDER BY created_at DESC
        LIMIT ${input.limit ?? 20}
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, rowToDelivery)),
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause)
            ? cause
            : storeError("Failed to list deliveries.", cause),
        ),
      );

    const listDueDeliveries: PullRequestMonitorFeedbackStoreApi["listDueDeliveries"] = (
      nowIso,
      limit,
    ) =>
      sql<DeliveryRow>`
        SELECT * FROM pull_request_monitor_feedback_deliveries
        WHERE status IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso})
        ORDER BY created_at ASC
        LIMIT ${limit}
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, rowToDelivery)),
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause)
            ? cause
            : storeError("Failed to list due deliveries.", cause),
        ),
      );

    const nextRevisionNumber: PullRequestMonitorFeedbackStoreApi["nextRevisionNumber"] = (itemId) =>
      sql<{ readonly max_revision: number | null }>`
        SELECT MAX(revision_number) AS max_revision
        FROM pull_request_monitor_feedback_revisions
        WHERE item_id = ${itemId}
      `.pipe(
        Effect.map((rows) => (rows[0]?.max_revision ?? 0) + 1),
        Effect.mapError((cause) => storeError("Failed to compute revision number.", cause)),
      );

    return {
      upsertOpenItem,
      insertRevision,
      findRevisionByIdentity,
      listRevisionsByIds,
      getItem,
      listItems,
      setDisposition,
      insertReport,
      reportDisposition,
      listReports,
      getState,
      appendPendingRevisionIds,
      removePendingRevisionIds,
      setDeliveryCircuitState,
      insertDelivery,
      updateDelivery,
      getDelivery,
      getDeliveryByBatchKey,
      listDeliveries,
      listDueDeliveries,
      nextRevisionNumber,
    } satisfies PullRequestMonitorFeedbackStoreApi;
  }),
};
