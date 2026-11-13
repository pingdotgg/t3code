import { threadErrorSummary } from "@t3tools/shared/orchestrationV2ThreadError";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isThreadHistoryUserTurn, THREAD_HISTORY_PAGE_POLICY } from "../threadHistoryPaging.ts";
import { activeLocalTurnItems, type ProjectionStoreV2Shape, type ProjectionWindow, withLocalVisibleTurnItems } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { ProjectionStoreReadError, ProjectionStoreSetupError, type ProjectionLimitRecoveryCandidate, type ProjectionRecoveryKind, type ProjectionStoreV2Error } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { booleanInt, buildVisibleTurnItems, decodeThreadPayload, decodeTurnItemPayload, inheritedRunFork, isProjectionStoreReadError, isProjectionStoreThreadNotFoundError } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart;

export const installReadProjection = Effect.fnUntraced(function* (deps: Deps) {
  const { readCanonicalProjection, retainedWindowRows, sql } = deps;

const readProjection: (
    threadId: ThreadId,
    seenThreadIds: ReadonlySet<ThreadId>,
    window?: ProjectionWindow,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error> = Effect.fn(
    "ProjectionStore.readProjection",
  )(
    function* (
      threadId: ThreadId,
      seenThreadIds: ReadonlySet<ThreadId>,
      window?: ProjectionWindow,
    ) {
      const localWindow =
        window?.suppressLocal === true ||
        (window?.historyAnchor !== undefined && window.historyAnchor.threadId !== threadId)
          ? { ...window, rowLimit: 0, anchorItemId: undefined }
          : window;
      const projection = yield* readCanonicalProjection(
        threadId,
        localWindow,
        window !== undefined && seenThreadIds.size > 0
          ? ["runs", "attempts", "turnItems"]
          : undefined,
      );
      const forkedFrom = inheritedRunFork(projection.thread);
      if (forkedFrom === null || seenThreadIds.has(forkedFrom.threadId)) {
        return withLocalVisibleTurnItems(projection);
      }

      // Page unanchored local segments fully before inherited turns affect the boundary.
      if (
        window?.userTurnLimit !== undefined &&
        localWindow !== undefined &&
        localWindow.rowLimit > 0 &&
        projection.turnItems.length >= localWindow.rowLimit &&
        !projection.turnItems.some(isThreadHistoryUserTurn)
      ) {
        return withLocalVisibleTurnItems(projection);
      }

      const sourceWindow =
        window === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const historyAnchor = window.historyAnchor;
              const anchorBelongsToSource = historyAnchor?.threadId === forkedFrom.threadId;
              const rows = yield* sql<{ readonly turn_item_id: string }>`
                WITH fork_run AS (
                  SELECT ordinal
                  FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${forkedFrom.threadId}
                    AND run_id = ${forkedFrom.runId}
                  LIMIT 1
                ), fork_boundary AS (
                  SELECT (
                    SELECT item.ordinal
                    FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.run_id = run.run_id
                    ORDER BY item.ordinal DESC
                    LIMIT 1
                  ) AS ordinal
                  FROM orchestration_v2_projection_runs AS run
                  WHERE run.thread_id = ${forkedFrom.threadId}
                    AND run.ordinal <= (SELECT ordinal FROM fork_run)
                    AND EXISTS (
                      SELECT 1
                      FROM orchestration_v2_projection_turn_items AS item
                      WHERE item.run_id = run.run_id
                      LIMIT 1
                    )
                  ORDER BY run.ordinal DESC
                  LIMIT 1
                ), effective_boundary AS (
                  SELECT COALESCE(
                    (SELECT ordinal FROM fork_boundary),
                    (
                      SELECT ordinal
                      FROM orchestration_v2_projection_turn_items
                      WHERE thread_id = ${forkedFrom.threadId}
                        AND run_id IS NULL
                        AND json_extract(payload_json, '$.historyOrigin') = 'v1_import'
                      ORDER BY ordinal DESC, turn_item_id DESC
                      LIMIT 1
                    ),
                    -1
                  ) AS ordinal
                )
                SELECT turn_item_id
                FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${forkedFrom.threadId}
                  AND ordinal <= COALESCE(
                    (SELECT ordinal FROM effective_boundary),
                    -1
                  )
                  AND (
                    ${anchorBelongsToSource ? 1 : 0} = 0
                    OR ordinal <= COALESCE(
                      (SELECT ordinal FROM orchestration_v2_projection_turn_items
                       WHERE thread_id = ${forkedFrom.threadId}
                         AND turn_item_id = ${historyAnchor?.itemId ?? null}
                       LIMIT 1),
                      (SELECT ordinal FROM effective_boundary),
                      -1
                    )
                  )
                ORDER BY ordinal DESC, turn_item_id DESC
                LIMIT 1
              `;
              const anchor = rows[0]?.turn_item_id;
              const anchorIsInDescendant =
                historyAnchor !== undefined &&
                historyAnchor.threadId !== threadId &&
                historyAnchor.threadId !== forkedFrom.threadId;
              return {
                rowLimit: window.rowLimit,
                userTurnLimit: window.userTurnLimit,
                deferWork: window.deferWork,
                requiredRunId: forkedFrom.runId,
                suppressLocal: anchor === undefined || anchorIsInDescendant,
                ...(anchor === undefined || anchorIsInDescendant
                  ? {}
                  : { anchorItemId: TurnItemId.make(anchor) }),
                ...(historyAnchor === undefined || historyAnchor.threadId === threadId
                  ? {}
                  : { historyAnchor }),
              };
            });

      // Filled local pages need only the inherited count for cursor positions.
      // Run-forked parents still need the recursive read to include their ancestry.
      if (
        window?.userTurnLimit !== undefined &&
        window.historyAnchor === undefined &&
        seenThreadIds.size === 0 &&
        sourceWindow !== undefined &&
        activeLocalTurnItems(projection).filter((row) => isThreadHistoryUserTurn(row.item))
          .length >= Math.max(window.userTurnLimit, THREAD_HISTORY_PAGE_POLICY.maxUserTurns)
      ) {
        const counted = yield* sql<{ readonly inherited_rows: number | null }>`
          ${yield* retainedWindowRows(forkedFrom.threadId, {
            ...sourceWindow,
            rowLimit: sourceWindow.suppressLocal ? 0 : sourceWindow.rowLimit,
          })}
          SELECT CASE
            WHEN json_extract(source.payload_json, '$.forkedFrom.type') = 'run' THEN NULL
            WHEN NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = source.thread_id AND run_id = ${forkedFrom.runId}
            ) THEN 0
            ELSE (SELECT COUNT(*) FROM retained)
          END AS inherited_rows
          FROM orchestration_v2_projection_threads AS source
          WHERE source.thread_id = ${forkedFrom.threadId}
        `;
        const inheritedRowCount = counted[0]?.inherited_rows ?? null;
        if (inheritedRowCount !== null) {
          return {
            ...projection,
            visibleTurnItems: buildVisibleTurnItems({
              projection,
              sourceProjection: null,
              inheritedRowCount,
            }),
          };
        }
      }

      const sourceProjection = yield* readProjection(
        forkedFrom.threadId,
        new Set([...seenThreadIds, threadId]),
        sourceWindow,
      );
      return {
        ...projection,
        visibleTurnItems: buildVisibleTurnItems({
          projection,
          sourceProjection,
        }),
      };
    },
    (effect, threadId, _seenThreadIds, _window?) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      ),
  );

const getLimitRecoveryCandidates = Effect.fn("ProjectionStore.getLimitRecoveryCandidates")(
    function* (options: Parameters<ProjectionStoreV2Shape["getLimitRecoveryCandidates"]>[0]) {
      const rows = yield* sql<{
        readonly payload_json: string;
        readonly run_id: string;
        readonly completed_at: string | null;
        readonly failure_payload_json: string;
        readonly last_error: string | null;
      }>`
        SELECT t.payload_json, r.run_id, r.completed_at,
          item.payload_json AS failure_payload_json,
          (
            SELECT json_extract(session.payload_json, '$.lastError')
            -- Keep bindings outermost: one provider instance can hold every session.
            FROM orchestration_v2_projection_provider_session_bindings binding
            CROSS JOIN orchestration_v2_projection_provider_sessions session
              ON session.provider_session_id = binding.provider_session_id
            WHERE binding.thread_id = t.thread_id
              AND session.provider_instance_id = t.provider_instance_id
            ORDER BY session.updated_at DESC, session.provider_session_id DESC
            LIMIT 1
          ) AS last_error
        FROM orchestration_v2_projection_threads t
        INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
          SELECT latest.run_id FROM orchestration_v2_projection_runs latest
          WHERE latest.thread_id = t.thread_id
            AND latest.status <> 'queued'
            AND NOT (
              latest.status = 'cancelled'
              AND json_extract(latest.payload_json, '$.startedAt') IS NULL
            )
          -- latestExecutedRun: the run that ended last (runRanAfter).
          ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
            latest.ordinal DESC, latest.run_id DESC
          LIMIT 1
        ) AND r.status = 'failed'
        INNER JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
          SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
          WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
            AND error.type = 'error' AND error.status = 'failed'
            AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
          ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
          LIMIT 1
        )
        WHERE t.deleted_at IS NULL
          -- The sweep runs every scheduler tick. Without this list the latest-run
          -- lookup above sorts every run of every thread, tens of milliseconds
          -- for one long thread; only threads with a usage-limit failure qualify.
          AND t.thread_id IN (
            SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure
            WHERE failure.type = 'error' AND failure.status = 'failed'
              AND json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'
          )
          AND json_extract(t.payload_json, '$.archivedAt') IS NULL
          AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
          AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
          AND json_extract(item.payload_json, '$.failure.resetAt') IS NOT NULL
          AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(COALESCE(r.completed_at, json_extract(t.payload_json, '$.updatedAt')))
          AND (
            (
              json_extract(t.payload_json, '$.limitRecovery.runId') IS r.run_id
              AND json_extract(t.payload_json, '$.limitRecovery.resetAt') IS json_extract(item.payload_json, '$.failure.resetAt')
              AND json_extract(t.payload_json, '$.limitRecovery.autoResume') = 1
              AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) <= julianday(${DateTime.formatIso(options.now)})
              AND (
                json_extract(t.payload_json, '$.snoozedUntil') IS NULL
                OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(options.now)})
              )
            )
            OR (
              (
                json_extract(t.payload_json, '$.limitRecovery.runId') IS NOT r.run_id
                OR json_extract(t.payload_json, '$.limitRecovery.resetAt') IS NOT json_extract(item.payload_json, '$.failure.resetAt')
              )
              AND (
                ${booleanInt(options.autoResume)}
                OR (${booleanInt(options.snooze)} AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(${DateTime.formatIso(options.now)}))
              )
              -- A subagent of a settled parent is abandoned work; resuming it would wake the parent.
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_threads parent
                WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
                  AND json_extract(parent.payload_json, '$.settledOverride') = 'settled'
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runtime_requests request
            WHERE request.thread_id = t.thread_id AND request.status = 'pending'
          )
        ORDER BY t.thread_id
      `;
      const candidates: Array<ProjectionLimitRecoveryCandidate> = [];
      for (const row of rows) {
        const thread = yield* decodeThreadPayload(row.payload_json);
        const item = yield* decodeTurnItemPayload(row.failure_payload_json);
        const summary = threadErrorSummary(
          item.type === "error" ? item.failure : null,
          row.last_error,
        );
        if (summary.lastErrorClass !== "usage_limit") continue;
        candidates.push({
          id: thread.id,
          status: "failed",
          lastErrorClass: summary.lastErrorClass,
          usageLimitResetAt: summary.usageLimitResetAt,
          latestRunId: RunId.make(row.run_id),
          latestRunCompletedAt:
            row.completed_at === null ? null : DateTime.makeUnsafe(row.completed_at),
          updatedAt: thread.updatedAt,
          archivedAt: thread.archivedAt,
          settledOverride: thread.settledOverride,
          pendingRuntimeRequest: null,
          limitRecovery: thread.limitRecovery ?? null,
          snoozedUntil: thread.snoozedUntil ?? null,
        });
      }
      return candidates;
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

const getLimitRecoveryWakeAt = Effect.fn("ProjectionStore.getLimitRecoveryWakeAt")(
    function* (now: DateTime.Utc) {
      const nowIso = DateTime.formatIso(now);
      const rows = yield* sql<{
        readonly reset_ms: number | null;
        readonly snooze_ms: number | null;
      }>`
        SELECT
          MIN(CASE WHEN julianday(reset_at) > julianday(${nowIso})
            THEN (julianday(reset_at) - 2440587.5) * 86400000 END) AS reset_ms,
          MIN(CASE WHEN julianday(snoozed_until) > julianday(${nowIso})
            THEN (julianday(snoozed_until) - 2440587.5) * 86400000 END) AS snooze_ms
        FROM (
          SELECT json_extract(payload_json, '$.limitRecovery.resetAt') AS reset_at,
            json_extract(payload_json, '$.snoozedUntil') AS snoozed_until
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
            AND json_extract(payload_json, '$.limitRecovery.autoResume') = 1
        )
      `;
      const wakes = [rows[0]?.reset_ms, rows[0]?.snooze_ms].filter(
        (value): value is number => value != null,
      );
      return wakes.length === 0 ? null : Math.round(Math.min(...wakes));
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

const getRecoveryThreadIds = Effect.fn("ProjectionStore.getRecoveryThreadIds")(
    function* (kind: ProjectionRecoveryKind) {
      const candidates = (() => {
        switch (kind) {
          case "queued-runs":
            return sql`
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS active
                  WHERE active.thread_id = orchestration_v2_projection_runs.thread_id
                    AND active.status IN ('preparing', 'starting', 'running', 'waiting')
                )
            `;
          case "delegated-completions":
            return sql`
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE CASE WHEN json_valid(payload_json)
                THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
                ELSE 0 END
            `;
          case "subagent-results":
            return sql`
              SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
              WHERE CASE WHEN json_valid(child.payload_json) THEN
                json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                AND json_extract(child.payload_json, '$.lineage.parentThreadId') IS NOT NULL
                AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
                ELSE 0 END
                AND (EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS requested
                  JOIN orchestration_v2_projection_subagents AS task
                    ON task.subagent_id = json_extract(requested.payload_json, '$.delegatedTaskId')
                  WHERE requested.thread_id = child.thread_id
                    AND requested.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                    AND task.child_thread_id = child.thread_id
                    AND json_extract(task.payload_json, '$.origin') = 'app_owned'
                    AND json_extract(task.payload_json, '$.result') IS NULL
                ) OR (
                  -- The original task still waits for the latest unheld work.
                  (SELECT status FROM orchestration_v2_projection_runs
                   WHERE thread_id = child.thread_id
                     AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
                   ORDER BY ordinal DESC LIMIT 1
                  ) IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                  AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_context_transfers
                  WHERE source_thread_id = child.thread_id
                    AND target_thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
                    AND type = 'subagent_result'
                )))
            `;
          case "runtime":
            return sql`
              WITH pending_provider_threads AS MATERIALIZED (
                SELECT provider_thread_id, thread_id, owner_node_id
                FROM orchestration_v2_projection_provider_threads
                WHERE status = 'active'
                  OR CASE WHEN json_valid(payload_json)
                    THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
              )
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status IN ('preparing', 'starting', 'running', 'waiting')
              UNION
              -- A held queue already went through recovery; rereading it on
              -- every boot costs a projection read per held thread.
              SELECT thread_id FROM orchestration_v2_projection_runs
              WHERE status = 'queued'
                AND CASE WHEN json_valid(payload_json)
                  THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
                  ELSE 1 END
              UNION
              SELECT thread_id FROM orchestration_v2_projection_runtime_requests
              WHERE status = 'pending'
              UNION
              SELECT bindings.thread_id
              FROM orchestration_v2_projection_provider_sessions AS sessions
              CROSS JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                ON bindings.provider_session_id = sessions.provider_session_id
              WHERE sessions.status NOT IN ('stopped', 'error')
              UNION
              -- A detach drops the binding but keeps the session's status.
              SELECT sessions.thread_id
              FROM orchestration_v2_projection_provider_sessions AS sessions
              WHERE sessions.status NOT IN ('stopped', 'error')
                AND sessions.thread_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS bindings
                  WHERE bindings.provider_session_id = sessions.provider_session_id
                )
              UNION
              SELECT thread_id FROM pending_provider_threads
              UNION
              SELECT nodes.thread_id FROM pending_provider_threads
              CROSS JOIN orchestration_v2_projection_nodes AS nodes
                ON nodes.node_id = pending_provider_threads.owner_node_id
              UNION
              SELECT subagents.thread_id FROM pending_provider_threads
              CROSS JOIN orchestration_v2_projection_subagents AS subagents
                ON subagents.provider_thread_id = pending_provider_threads.provider_thread_id
              UNION
              SELECT subagents.child_thread_id FROM orchestration_v2_projection_subagents AS subagents
              WHERE subagents.child_thread_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_nodes AS node
                  WHERE node.thread_id = subagents.child_thread_id
                    -- Matches nodes_live_idx; +run_id keeps thread_run_idx from scanning settled nodes.
                    AND node.status IN ('pending', 'starting', 'running', 'waiting')
                    AND +node.run_id IS NULL
                    AND node.kind = 'root_turn'
                )
              UNION
              -- No native subagent outlives the provider process that ran it.
              SELECT thread_id FROM orchestration_v2_projection_subagents
              WHERE origin = 'provider_native'
                AND status IN ('pending', 'running', 'waiting')
              UNION
              SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
              WHERE NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS run
                  WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                )
                AND type IN ('command_execution', 'dynamic_tool', 'subagent')
                AND status IN ('pending', 'running', 'waiting')
              UNION
              SELECT thread_id FROM orchestration_v2_effect_outbox
              WHERE status IN ('pending', 'running')
            `;
        }
      })();
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND thread_id IN (${candidates})
          ${kind === "queued-runs" ? sql`AND archived_at IS NULL` : sql``}
        ORDER BY updated_at ASC, thread_id ASC
      `;
      return rows.map((row) => ThreadId.make(row.thread_id));
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

  return { readProjection, getLimitRecoveryCandidates, getLimitRecoveryWakeAt, getRecoveryThreadIds };
});

export type ReadProjectionPart = ReturnType<typeof installReadProjection> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installReadProjection>;
