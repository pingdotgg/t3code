import { applyThreadPullRequestLinkUpdate } from "../../sourceControl/threadPullRequests.ts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { THREAD_HISTORY_MAX_RAW_TURNS, THREAD_HISTORY_PAGE_POLICY, THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT, THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT } from "../threadHistoryPaging.ts";
import { type ProjectionStoreV2Shape, type ProjectionWindow } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { encodeThreadPayload, encodeThreadUpdatedAt, nullableStringField, parseEncodedPayload, stringField } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { ProjectionStoreApplyEventError } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart;

export const installRetainedWindowRows = Effect.fnUntraced(function* (deps: Deps) {
  const { applyRunTail, getThread, inlineWorkOutput, sql } = deps;

const apply: ProjectionStoreV2Shape["apply"] =
    /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
    Effect.fnUntraced(
      function* (event) {
        switch (event.type) {
          case "thread.pull-request-link-updated": {
            const thread = yield* getThread(event.threadId);
            yield* apply({
              ...event,
              type: "thread.pull-request-synced",
              payload: applyThreadPullRequestLinkUpdate(thread, event.payload),
            });
            break;
          }
          case "thread.created":
          case "thread.archived":
          case "thread.unarchived":
          case "thread.deleted":
          case "thread.settled":
          case "thread.unsettled":
          case "thread.snoozed":
          case "thread.unsnoozed":
          case "thread.auto-settle-set":
          case "thread.pinned":
          case "thread.unpinned":
          case "thread.pin-reordered":
          case "thread.active-reordered":
          case "thread.tags-updated":
          case "thread.visited":
          case "thread.marked-unread":
          case "thread.metadata-updated":
          case "thread.pull-request-synced":
          case "thread.runtime-mode-updated":
          case "thread.interaction-mode-updated":
          case "thread.model-selection-updated":
          case "thread.provider-switched":
          case "thread.guest-share-updated": {
            const payloadJson = yield* encodeThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_threads (
              thread_id,
              project_id,
              title,
              default_provider,
              provider_instance_id,
              runtime_mode,
              interaction_mode,
              active_provider_thread_id,
              created_at,
              updated_at,
              archived_at,
              deleted_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.projectId},
              ${event.payload.title},
              ${event.payload.providerInstanceId},
              ${event.payload.providerInstanceId},
              ${event.payload.runtimeMode},
              ${event.payload.interactionMode},
              ${event.payload.activeProviderThreadId},
              ${stringField(payload, "createdAt")},
              ${stringField(payload, "updatedAt")},
              ${nullableStringField(payload, "archivedAt")},
              ${nullableStringField(payload, "deletedAt")},
              ${payloadJson}
            )
            ON CONFLICT(thread_id)
            DO UPDATE SET
              project_id = excluded.project_id,
              title = excluded.title,
              default_provider = excluded.default_provider,
              provider_instance_id = excluded.provider_instance_id,
              runtime_mode = excluded.runtime_mode,
              interaction_mode = excluded.interaction_mode,
              active_provider_thread_id = excluded.active_provider_thread_id,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              archived_at = excluded.archived_at,
              deleted_at = excluded.deleted_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          default: {
            yield* applyRunTail(event);
            break;
          }
        }

        if (
          event.type !== "thread.created" &&
          event.type !== "thread.archived" &&
          event.type !== "thread.unarchived" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.settled" &&
          event.type !== "thread.unsettled" &&
          event.type !== "thread.snoozed" &&
          event.type !== "thread.unsnoozed" &&
          event.type !== "thread.auto-settle-set" &&
          event.type !== "thread.pinned" &&
          event.type !== "thread.unpinned" &&
          event.type !== "thread.pin-reordered" &&
          event.type !== "thread.active-reordered" &&
          event.type !== "thread.tags-updated" &&
          event.type !== "thread.visited" &&
          event.type !== "thread.marked-unread" &&
          event.type !== "thread.metadata-updated" &&
          event.type !== "thread.pull-request-synced" &&
          event.type !== "thread.pull-request-link-updated" &&
          event.type !== "thread.runtime-mode-updated" &&
          event.type !== "thread.interaction-mode-updated" &&
          event.type !== "thread.model-selection-updated" &&
          event.type !== "thread.provider-switched" &&
          event.type !== "thread.guest-share-updated"
        ) {
          const updatedAt = yield* encodeThreadUpdatedAt(event.occurredAt);
          yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET
            updated_at = ${updatedAt},
            payload_json = json_set(payload_json, '$.updatedAt', ${updatedAt})
          WHERE thread_id = ${event.threadId}
        `;
        }
      },
      (effect, event) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProjectionStoreApplyEventError({
                eventType: event.type,
                cause,
              }),
          ),
        ),
    );

const retainedWindowRows = Effect.fn("ProjectionStore.retainedWindowRows")(function* (
    threadId: ThreadId,
    window: ProjectionWindow,
  ) {
    const eligible = sql`
              WITH eligible AS NOT MATERIALIZED (
                SELECT item.rowid AS item_rowid, item.payload_json, item.ordinal, item.turn_item_id,
                  item.run_id, item.node_id, item.type, item.status, run.status AS run_status,
                  attempt.attempt_id, attempt.status AS attempt_status
                FROM orchestration_v2_projection_turn_items AS item
                LEFT JOIN orchestration_v2_projection_runs AS run
                  ON run.run_id = item.run_id
                LEFT JOIN orchestration_v2_projection_nodes AS node
                  ON ${window.deferWork ? 1 : 0} = 1 AND node.node_id = item.node_id
                LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
                  ON ${window.deferWork ? 1 : 0} = 1 AND attempt.attempt_id = (
                    SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                    WHERE run_id = item.run_id AND root_node_id = COALESCE(node.root_node_id, item.node_id)
                    ORDER BY attempt_ordinal DESC LIMIT 1
                  )
                WHERE item.thread_id = ${threadId}
                  AND item.ordinal <= COALESCE(
                    (
                      SELECT ordinal
                      FROM orchestration_v2_projection_turn_items
                      WHERE thread_id = ${threadId}
                        AND turn_item_id = ${window.anchorItemId ?? null}
                      LIMIT 1
                    ),
                    9223372036854775807
                  )
                  AND (
                    ${window.requiredRunId ?? null} IS NOT NULL
                    OR (
                      (run.status IS NULL OR run.status <> 'rolled_back')
                      AND NOT (
                        item.type = 'user_message'
                        AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
                        AND run.status IS 'cancelled'
                      )
                    )
                  )
                  AND (
                    ${window.requiredRunId ?? null} IS NULL
                    OR (
                      item.run_id IS NULL
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_threads AS source_thread
                        WHERE source_thread.thread_id = item.thread_id
                          AND json_extract(source_thread.payload_json, '$.historyOrigin') = 'v1_import'
                      )
                    )
                    OR run.ordinal <= (
                      SELECT required_run.ordinal
                      FROM orchestration_v2_projection_runs AS required_run
                      WHERE required_run.thread_id = item.thread_id
                        AND required_run.run_id = ${window.requiredRunId ?? null}
                      LIMIT 1
                    )
                  )
                  AND NOT (
                    item.type = 'run_interrupt_result'
                    AND EXISTS (
                      SELECT 1
                      FROM orchestration_v2_projection_run_attempts AS attempt
                      WHERE attempt.run_id = item.run_id
                        AND attempt.root_node_id = item.node_id
                        AND attempt.status = 'superseded'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM orchestration_v2_projection_turn_items AS request
                      WHERE request.thread_id = item.thread_id
                        AND request.run_id = item.run_id
                        AND request.type = 'run_interrupt_request'
                    )
                  )
              )`;
    // Resolve anchors separately: repeated CTE expansion exceeds SQLite's subquery limit.
    const anchors = yield* sql<{ readonly ordinal: number; readonly latest: number | null }>`
              ${eligible}, run_starts AS (
                -- A wake (PR watch, task completion) starts its run with a
                -- notification instead of a user message. Read the first
                -- input of each run, newest run first, and add the
                -- notifications to the user-message turn starts. A run
                -- without an eligible first input (queued, rolled back) is
                -- skipped, so it cannot hide older turns. CROSS JOIN keeps
                -- the runs as the outer loop, and each probe reads only the
                -- first rows of a run.
                SELECT start.ordinal, start.type
                FROM orchestration_v2_projection_runs AS recent_run
                CROSS JOIN eligible AS start ON start.item_rowid = (
                  SELECT first_input.rowid
                  FROM orchestration_v2_projection_turn_items AS first_input
                  WHERE first_input.run_id = recent_run.run_id
                    AND first_input.type IN ('user_message', 'notification')
                  ORDER BY first_input.ordinal
                  LIMIT 1
                )
                WHERE recent_run.thread_id = ${threadId}
                  AND recent_run.ordinal <= COALESCE(
                    (
                      SELECT anchor_run.ordinal
                      FROM orchestration_v2_projection_turn_items AS anchor_item
                      JOIN orchestration_v2_projection_runs AS anchor_run
                        ON anchor_run.run_id = anchor_item.run_id
                      WHERE anchor_item.thread_id = ${threadId}
                        AND anchor_item.turn_item_id = ${window.anchorItemId ?? null}
                      LIMIT 1
                    ),
                    9223372036854775807
                  )
                  AND ${window.userTurnLimit ?? null} IS NOT NULL
                ORDER BY recent_run.ordinal DESC
                LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
              ), turn_anchors AS (
                SELECT ordinal, payload_json
                FROM (
                  SELECT ordinal, payload_json
                  FROM eligible
                  WHERE type = 'user_message'
                    AND json_extract(payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
                    AND ${window.userTurnLimit ?? null} IS NOT NULL
                  ORDER BY ordinal DESC
                  LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                )
                UNION ALL
                SELECT ordinal, NULL FROM run_starts WHERE type = 'notification'
                ORDER BY ordinal DESC
                LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
              ), user_anchors AS (
                SELECT ordinal
                FROM turn_anchors
                WHERE json_extract(payload_json, '$.createdBy') = 'user'
                ORDER BY ordinal DESC
                LIMIT ${(window.userTurnLimit ?? 0) + 2}
              ), boundary AS (
                SELECT CASE
                  WHEN COUNT(*) >= ${(window.userTurnLimit ?? 0) + 2} THEN MIN(ordinal)
                  WHEN (SELECT COUNT(*) FROM turn_anchors) >= ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                    THEN (SELECT MIN(ordinal) FROM turn_anchors)
                  ELSE 0
                END AS ordinal
                FROM user_anchors
              )
              SELECT ordinal, (SELECT MAX(ordinal) FROM user_anchors) AS latest FROM boundary
            `;
    const boundary = anchors[0]!;
    return sql`
              ${eligible}, blocked_runs AS MATERIALIZED (
                SELECT DISTINCT run_id FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${threadId} AND run_id IS NOT NULL
                  AND ${window.deferWork ? 1 : 0} = 1
                  AND run_id IN (
                    SELECT run_id FROM eligible
                    WHERE ordinal >= ${boundary.ordinal} AND run_id IS NOT NULL
                  )
                  AND (type IN ('run_interrupt_request', 'run_interrupt_result')
                    OR (type = 'error' AND status = 'failed' AND parent_item_id IS NULL))
              ), work_segments AS (
                SELECT item_rowid, ordinal, turn_item_id, run_id, type, attempt_id,
                  MAX(CASE WHEN type = 'user_message' THEN ordinal ELSE 0 END)
                    OVER (PARTITION BY run_id ORDER BY ordinal) AS segment,
                  CASE WHEN status = 'completed' AND (run_status = 'completed' OR attempt_status = 'superseded')
                    AND type IN ('command_execution', 'reasoning', 'file_change', 'file_search', 'web_search', 'dynamic_tool')
                    AND NOT (${inlineWorkOutput})
                    AND run_id NOT IN (SELECT run_id FROM blocked_runs)
                    THEN 1 ELSE 0 END AS can_defer
                FROM eligible AS item
                WHERE ${window.deferWork ? 1 : 0} = 1
                  AND ${boundary.latest === null ? 0 : 1} = 1
                  AND ordinal >= ${boundary.ordinal}
              ), deferred_work AS (
                SELECT run_id, segment, attempt_id, MIN(ordinal) AS first_ordinal,
                  MAX(ordinal) AS last_ordinal, COUNT(*) AS item_count
                FROM work_segments WHERE can_defer = 1
                GROUP BY run_id, segment, attempt_id HAVING COUNT(*) > ${THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT}
              ), window_items AS NOT MATERIALIZED (
                SELECT item_rowid, ordinal, turn_item_id, run_id, type
                FROM eligible WHERE ${window.deferWork ? 1 : 0} = 0
                  OR ${boundary.latest === null ? 1 : 0} = 1
                UNION ALL
                SELECT item.item_rowid, item.ordinal, item.turn_item_id, item.run_id, item.type
                FROM work_segments item LEFT JOIN deferred_work deferred
                  ON deferred.run_id = item.run_id AND deferred.segment = item.segment
                  AND deferred.attempt_id IS item.attempt_id
                WHERE item.can_defer = 0 OR deferred.run_id IS NULL OR item.ordinal = deferred.first_ordinal
              ), latest_user_turn AS (
                -- Mirrors selectOlderTimelinePage: whole turns while the
                -- newest user turn fits the turn row budget, otherwise the
                -- window pages from inside that turn with the row limit.
                SELECT COUNT(*) AS row_count
                FROM (
                  SELECT 1
                  FROM window_items
                  WHERE ordinal >= ${boundary.latest}
                  LIMIT ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 1}
                )
              ), selected AS (
                -- Choose and sort rows by ID, then fetch payloads in that
                -- order. A turn window can hold megabytes of tool output, and
                -- carrying it through the union and sort cost about a second.
                SELECT item_rowid, ordinal, turn_item_id, run_id, type
                FROM window_items
                WHERE ordinal >= ${boundary.ordinal}
                ORDER BY ordinal DESC, turn_item_id DESC
                LIMIT CASE
                  WHEN ${window.rowLimit} = 0 THEN 0
                  WHEN (SELECT row_count FROM latest_user_turn)
                    BETWEEN 1 AND ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems}
                    THEN ${THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT}
                  ELSE ${window.rowLimit}
                END
              ), retained AS MATERIALIZED (
                SELECT item_rowid, ordinal, turn_item_id FROM selected
                UNION
                SELECT request.rowid AS item_rowid, request.ordinal, request.turn_item_id
                FROM orchestration_v2_projection_turn_items AS request
                WHERE request.run_id IN (
                    SELECT run_id FROM selected
                    WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
                  )
                  AND request.type = 'run_interrupt_request'
                UNION
                -- An open question or approval stays in the window: clients
                -- build the answer panel from its row, and a run that kept
                -- working pushes the row out of the newest turns.
                SELECT question.rowid AS item_rowid, question.ordinal, question.turn_item_id
                FROM orchestration_v2_projection_runtime_requests AS pending
                JOIN orchestration_v2_projection_turn_items AS question
                  ON question.node_id = pending.node_id
                WHERE pending.thread_id = ${threadId}
                  AND pending.status = 'pending'
                  AND question.thread_id = ${threadId}
                  AND question.type IN ('user_input_request', 'approval_request')
                  AND ${window.rowLimit} > 0
                  AND ${window.anchorItemId ?? null} IS NULL
                  AND ${window.requiredRunId ?? null} IS NULL
                UNION
                SELECT latest.item_rowid, latest.ordinal, latest.turn_item_id
                FROM (
                  SELECT rowid AS item_rowid, ordinal, turn_item_id
                  FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${threadId}
                    AND ${window.anchorItemId ?? null} IS NULL
                    AND ${window.requiredRunId ?? null} IS NULL
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT 1
                ) AS latest
                ORDER BY ordinal ASC, turn_item_id ASC
              )
            `;
  });

  return { apply, retainedWindowRows };
});

export type RetainedWindowRowsPart = ReturnType<typeof installRetainedWindowRows> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRetainedWindowRows>;
