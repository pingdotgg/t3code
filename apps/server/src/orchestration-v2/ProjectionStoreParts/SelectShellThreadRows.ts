import { pendingGuestMessageCount } from "@t3tools/contracts";
import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";
import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { orchestrationV2RunWorkStartedAt, RunId, ThreadId, NodeId, ProviderInstanceId } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ProjectionStoreSetupError, type ProjectionSettlementCandidate, type ProjectionThreadPullRequests, type ShellSnapshotOptions } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { decodeProviderThreadPayload, decodeThreadPayload, decodeTurnItemPayload, encodeIdList, type SettlementThreadRow, type ShellItemCountRow, type ShellRunItemCountRow, type ShellRunRow, type ShellThreadRow } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { type PayloadRow, type ProjectionStoreV2Shape, type ShellPendingTurnItemRow } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { shellStatusFromStoredRunStatus } from "../ProjectionStorePrelude/ThreadShellFromProjection.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";
import type { GetUnreadableThreadIdsPart } from "./GetUnreadableThreadIds.ts";
import type { GetRuntimeRecoveryProjectionPart } from "./GetRuntimeRecoveryProjection.ts";
import type { GetCheckpointRollbackContextPart } from "./GetCheckpointRollbackContext.ts";
import type { ReadTimelineIndexPart } from "./ReadTimelineIndex.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart & GetUnreadableThreadIdsPart & GetRuntimeRecoveryProjectionPart & GetCheckpointRollbackContextPart & ReadTimelineIndexPart;

export const installSelectShellThreadRows = Effect.fnUntraced(function* (deps: Deps) {
  const { isIdleCompactionMessage, isSilentShellRun, sql } = deps;

const selectShellThreadRows = (
    threadId?: ThreadId,
    {
      location,
      projectId,
      unsettledOnly = false,
      familyOf,
      worktreePath,
      threadIds,
    }: ShellSnapshotOptions = {},
  ) =>
    sql<ShellThreadRow>`
          SELECT
            t.thread_id,
            t.payload_json,
            CASE
              WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
                AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
                THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
              ELSE NULL
            END AS forked_from_run_source_thread_id,
            presented.run_id AS latest_run_id,
            presented.status AS latest_run_status,
            presented.requested_at AS latest_run_requested_at,
            json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
            presented.completed_at AS latest_run_completed_at,
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
              WHERE stop_request.thread_id = t.thread_id AND stop_request.run_id = presented.run_id
                AND stop_request.type = 'run_interrupt_request'
            ) AS latest_run_stop_requested,
            active.run_id AS active_run_id,
            active.status AS active_run_status,
            (
              SELECT r.status
              FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                AND NOT ${isSilentShellRun("r")}
              ORDER BY r.ordinal DESC, r.run_id DESC
              LIMIT 1
            ) AS activity_run_status,
            (
              -- Mirrors orchestrationV2RunWorkStartedAt.
              SELECT COALESCE(
                json_extract(r.payload_json, '$.workStartedAt'),
                json_extract(r.payload_json, '$.startedAt'),
                r.requested_at
              )
              FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                AND NOT ${isSilentShellRun("r")}
              ORDER BY r.ordinal DESC, r.run_id DESC
              LIMIT 1
            ) AS activity_run_started_at,
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
            ) AS last_error,
            (
              SELECT item.payload_json
              FROM orchestration_v2_projection_turn_items item
              INNER JOIN orchestration_v2_projection_runs r ON r.run_id = item.run_id
              WHERE r.run_id = presented.run_id
                AND r.status = 'failed'
                AND item.thread_id = t.thread_id
                AND item.type = 'error' AND item.status = 'failed'
                AND item.node_id IS json_extract(r.payload_json, '$.rootNodeId')
              ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
              LIMIT 1
            ) AS terminal_failure_payload_json,
            blocked.run_id AS blocking_run_id,
            blocked.requested_at AS blocking_run_requested_at,
            json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
            blocked.completed_at AS blocking_run_completed_at,
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
              WHERE stop_request.thread_id = t.thread_id AND stop_request.run_id = blocked.run_id
                AND stop_request.type = 'run_interrupt_request'
            ) AS blocking_run_stop_requested,
            (
              SELECT item.payload_json
              FROM orchestration_v2_projection_turn_items item
              WHERE item.thread_id = t.thread_id
                AND item.run_id = blocked.run_id
                AND item.type = 'error' AND item.status = 'failed'
                AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
              ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
              LIMIT 1
            ) AS blocking_failure_payload_json,
            (
              SELECT request.payload_json
              FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id
                AND request.status = 'pending'
              ORDER BY request.created_at DESC, request.runtime_request_id DESC
              LIMIT 1
            ) AS pending_request_payload_json,
            (
              SELECT secret.payload_json
              -- Keep runs outermost so completed history is never scanned for a pending secret.
              FROM orchestration_v2_projection_runs r
              CROSS JOIN orchestration_v2_projection_turn_items secret
                INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                AND secret.thread_id = t.thread_id AND secret.run_id = r.run_id
                AND secret.type = 'secret_request' AND secret.status = 'waiting'
              ORDER BY secret.updated_at DESC, secret.turn_item_id DESC
              LIMIT 1
            ) AS pending_secret_request_payload_json,
            (
              SELECT link.payload_json
              FROM orchestration_v2_projection_turn_items link
                INDEXED BY orchestration_v2_projection_turn_items_waiting_link_idx
              WHERE link.thread_id = t.thread_id
                AND link.type = 'link_request' AND link.status = 'waiting'
              ORDER BY link.updated_at DESC, link.turn_item_id DESC
              LIMIT 1
            ) AS pending_link_request_payload_json,
            (
              SELECT message.updated_at
              FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = t.thread_id
                AND message.role = 'user'
                AND NOT ${isIdleCompactionMessage("message")}
              ORDER BY message.updated_at DESC, message.message_id DESC
              LIMIT 1
            ) AS latest_user_message_at,
            (
              SELECT message.updated_at
              FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = t.thread_id
                AND message.role = 'user'
                AND json_extract(message.payload_json, '$.createdBy') = 'user'
                AND NOT ${isIdleCompactionMessage("message")}
              ORDER BY message.updated_at DESC, message.message_id DESC
              LIMIT 1
            ) AS latest_user_authored_message_at,
            EXISTS (
              SELECT 1
              FROM orchestration_v2_projection_plans plan
              WHERE plan.thread_id = t.thread_id
                AND plan.kind = 'proposed_plan'
                AND plan.status = 'active'
            ) AS has_actionable_proposed_plan
          FROM orchestration_v2_projection_threads t
          LEFT JOIN orchestration_v2_projection_runs active ON active.run_id = (
            SELECT r.run_id
            FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = t.thread_id
              AND r.status IN ('preparing', 'starting', 'running')
              AND NOT ${isSilentShellRun("r")}
            ORDER BY r.ordinal DESC, r.run_id DESC
            LIMIT 1
          )
          -- The newest run not waiting in a held queue, matching latestUnheldRun.
          LEFT JOIN orchestration_v2_projection_runs presented ON presented.run_id = (
            SELECT candidate.run_id
            FROM orchestration_v2_projection_runs candidate
            WHERE candidate.thread_id = t.thread_id
              AND NOT (
                candidate.status = 'queued'
                AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
              )
              AND NOT ${isSilentShellRun("candidate")}
            ORDER BY candidate.ordinal DESC, candidate.run_id DESC
            LIMIT 1
          )
          LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
            SELECT candidate.run_id
            FROM orchestration_v2_projection_runs candidate
            WHERE candidate.thread_id = t.thread_id
              AND candidate.status <> 'queued'
              AND NOT (
                candidate.status = 'cancelled'
                AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
              )
            -- latestExecutedRun: the run that ended last (runRanAfter).
            ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
              candidate.ordinal DESC, candidate.run_id DESC
            LIMIT 1
          ) AND blocked.status = 'failed'
          WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}${
            projectId === undefined ? sql`` : sql` AND t.project_id = ${projectId}`
          }${
            location === "active"
              ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
              : location === "archive"
                ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NOT NULL`
                : sql``
          }${
            unsettledOnly
              ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
              : sql``
          }${
            familyOf === undefined
              ? sql``
              : sql` AND json_extract(t.payload_json, '$.lineage.rootThreadId') = (
                  SELECT json_extract(member.payload_json, '$.lineage.rootThreadId')
                  FROM orchestration_v2_projection_threads member
                  WHERE member.thread_id = ${familyOf}
                )`
          }${
            worktreePath === undefined
              ? sql``
              : sql` AND json_extract(t.payload_json, '$.worktreePath') = ${worktreePath}`
          }${threadIds === undefined ? sql`` : sql` AND t.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))`}
          ORDER BY t.updated_at ASC, t.thread_id ASC
        `;

const selectShellRunRows = (threadIds?: ReadonlyArray<ThreadId>) =>
    threadIds === undefined
      ? sql<ShellRunRow>`
          SELECT thread_id, run_id, ordinal
          FROM orchestration_v2_projection_runs
        `
      : sql<ShellRunRow>`
          SELECT thread_id, run_id, ordinal
          FROM orchestration_v2_projection_runs
          WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
        `;

const selectShellRunItemCounts = (threadIds: ReadonlyArray<ThreadId>) =>
    sql<ShellRunItemCountRow>`
      SELECT thread_id, run_id, COUNT(*) AS item_count
      FROM orchestration_v2_projection_turn_items
      WHERE run_id IS NOT NULL AND thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
      GROUP BY thread_id, run_id
    `;

const selectShellItemCounts = (threadIds: ReadonlyArray<ThreadId>) =>
    sql<ShellItemCountRow>`
      SELECT counts.thread_id,
        SUM(CASE WHEN counts.run_id IS NULL OR r.status <> 'rolled_back'
          THEN counts.item_count ELSE 0 END) AS item_count,
        SUM(CASE WHEN counts.run_id IS NULL THEN counts.item_count ELSE 0 END)
          AS runless_item_count
      FROM (
        SELECT thread_id, run_id, COUNT(*) AS item_count
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
        GROUP BY thread_id, run_id
      ) counts
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = counts.run_id
      GROUP BY counts.thread_id
    `;

const selectShellProviderThreadRows = (threadIds?: ReadonlyArray<ThreadId>) =>
    threadIds === undefined
      ? sql<PayloadRow & { readonly thread_id: string }>`
          SELECT thread_id, payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IS NOT NULL
        `
      : sql<PayloadRow & { readonly thread_id: string }>`
          SELECT thread_id, payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))
        `;

const selectShellPendingTurnItemRows = (
    threadIds?: ReadonlyArray<ThreadId>,
    activeRunIds: ReadonlyArray<string> = [],
  ) => sql<ShellPendingTurnItemRow>`
    SELECT i.thread_id, i.payload_json, p.provider_instance_id AS owning_provider_instance_id
    FROM orchestration_v2_projection_turn_items i
    LEFT JOIN orchestration_v2_projection_provider_threads p
      ON p.provider_thread_id = i.provider_thread_id
    LEFT JOIN orchestration_v2_projection_runs r
      ON r.run_id = i.run_id
    WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
      AND (i.run_id IS NULL OR r.status <> 'rolled_back')
      ${threadIds === undefined ? sql`` : sql`AND i.thread_id IN (SELECT value FROM json_each(${encodeIdList(threadIds)}))`}
    ${
      activeRunIds.length === 0
        ? sql``
        : sql`
      -- Preserve the pending-item partial index; read other work only from running runs.
      UNION ALL
      SELECT i.thread_id, i.payload_json, NULL AS owning_provider_instance_id
      FROM orchestration_v2_projection_turn_items i
      WHERE i.run_id IN (SELECT value FROM json_each(${encodeIdList(activeRunIds)}))
        AND i.type IN ('file_change', 'file_search', 'web_search', 'compaction')
        AND i.status IN ('running', 'waiting')
    `
    }
  `;

const runMapsByThreadId = (input: {
    readonly runRows: ReadonlyArray<ShellRunRow>;
    readonly itemCountRows: ReadonlyArray<ShellRunItemCountRow>;
  }) => {
    const runOrdinalsByThreadId = new Map<ThreadId, Map<RunId, number>>();
    for (const row of input.runRows) {
      const threadId = ThreadId.make(row.thread_id);
      const runId = RunId.make(row.run_id);
      const existing = runOrdinalsByThreadId.get(threadId) ?? new Map<RunId, number>();
      existing.set(runId, row.ordinal);
      runOrdinalsByThreadId.set(threadId, existing);
    }
    const itemCountsByThreadId = new Map<ThreadId, Map<RunId, number>>();
    for (const row of input.itemCountRows) {
      const threadId = ThreadId.make(row.thread_id);
      const runId = RunId.make(row.run_id);
      const existing = itemCountsByThreadId.get(threadId) ?? new Map<RunId, number>();
      existing.set(runId, row.item_count);
      itemCountsByThreadId.set(threadId, existing);
    }
    return { runOrdinalsByThreadId, itemCountsByThreadId };
  };

const shellItemCountMap = (rows: ReadonlyArray<ShellItemCountRow>) =>
    new Map(
      rows.map(
        (row) =>
          [
            ThreadId.make(row.thread_id),
            { itemCount: row.item_count, runlessItemCount: row.runless_item_count },
          ] as const,
      ),
    );

const pendingBackgroundDataByThreadId = Effect.fn(
    "ProjectionStore.pendingBackgroundDataByThreadId",
  )(function* (input: {
    readonly providerThreadRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
    readonly pendingTurnItemRows: ReadonlyArray<ShellPendingTurnItemRow>;
  }) {
    const providerThreadsByThreadId = new Map<
      ThreadId,
      Array<OrchestrationV2ThreadProjection["providerThreads"][number]>
    >();
    for (const row of input.providerThreadRows) {
      const providerThread = yield* decodeProviderThreadPayload(row.payload_json);
      const threadId =
        row.thread_id.length > 0 ? ThreadId.make(row.thread_id) : providerThread.appThreadId;
      if (threadId === null) {
        continue;
      }
      const existing = providerThreadsByThreadId.get(threadId) ?? [];
      existing.push(providerThread);
      providerThreadsByThreadId.set(threadId, existing);
    }

    const pendingTurnItemsByThreadId = new Map<ThreadId, Array<OrchestrationV2TurnItem>>();
    for (const row of input.pendingTurnItemRows) {
      const turnItem = {
        ...(yield* decodeTurnItemPayload(row.payload_json)),
        ...(row.owning_provider_instance_id === null
          ? {}
          : {
              owningProviderInstanceId: ProviderInstanceId.make(row.owning_provider_instance_id),
            }),
      };
      const threadId = ThreadId.make(row.thread_id);
      const existing = pendingTurnItemsByThreadId.get(threadId) ?? [];
      existing.push(turnItem);
      pendingTurnItemsByThreadId.set(threadId, existing);
    }

    return { providerThreadsByThreadId, pendingTurnItemsByThreadId };
  });

const getSettlementCandidates: ProjectionStoreV2Shape["getSettlementCandidates"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<SettlementThreadRow>`
          SELECT t.thread_id, t.payload_json,
            r.run_id AS latest_run_id,
            r.status AS latest_run_status,
            r.requested_at AS latest_run_requested_at,
            json_extract(r.payload_json, '$.startedAt') AS latest_run_started_at,
            r.completed_at AS latest_run_completed_at,
            (
              SELECT message.updated_at
              FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = t.thread_id AND message.role = 'user'
                AND NOT ${isIdleCompactionMessage("message")}
              ORDER BY message.updated_at DESC, message.message_id DESC
              LIMIT 1
            ) AS latest_user_message_at,
            (
              SELECT message.updated_at
              FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = t.thread_id AND message.role = 'user'
                AND json_extract(message.payload_json, '$.createdBy') = 'user'
                AND NOT ${isIdleCompactionMessage("message")}
              ORDER BY message.updated_at DESC, message.message_id DESC
              LIMIT 1
            ) AS latest_user_authored_message_at
          FROM orchestration_v2_projection_threads t
          LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
            SELECT latest.run_id FROM orchestration_v2_projection_runs latest
            WHERE latest.thread_id = t.thread_id
              AND NOT ${isSilentShellRun("latest")}
            ORDER BY latest.ordinal DESC, latest.run_id DESC
            LIMIT 1
          )
          WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}
            AND json_extract(t.payload_json, '$.archivedAt') IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NULL
            AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
            AND json_extract(t.payload_json, '$.autoSettleDisabledAt') IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs active
              WHERE active.thread_id = t.thread_id
                AND active.status IN ('preparing', 'starting', 'running', 'waiting')
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items link
                INDEXED BY orchestration_v2_projection_turn_items_waiting_link_idx
              WHERE link.thread_id = t.thread_id
                AND link.type = 'link_request' AND link.status = 'waiting'
                -- linkCardStillAsks: once the user writes after the card, it stops asking.
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_messages message
                  WHERE message.thread_id = t.thread_id AND message.role = 'user'
                    AND json_extract(message.payload_json, '$.createdBy') = 'user'
                    AND NOT ${isIdleCompactionMessage("message")}
                    AND message.updated_at > COALESCE(
                      json_extract(link.payload_json, '$.startedAt'), link.updated_at
                    )
                )
            )
          ORDER BY t.updated_at ASC, t.thread_id ASC
        `;
          if (rows.length === 0) return [];
          const threadIds = rows.map((row) => ThreadId.make(row.thread_id));
          const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
            yield* pendingBackgroundDataByThreadId({
              providerThreadRows: yield* selectShellProviderThreadRows(threadIds),
              pendingTurnItemRows: yield* selectShellPendingTurnItemRows(threadIds),
            });
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const thread = yield* decodeThreadPayload(row.payload_json);
              const status = shellStatusFromStoredRunStatus(row.latest_run_status);
              const latestRunId =
                row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
              return {
                ...thread,
                pinnedAt: thread.pinnedAt ?? null,

                autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
                snoozedUntil: thread.snoozedUntil ?? null,
                snoozedAt: thread.snoozedAt ?? null,
                status,
                latestRunId,
                latestRunRequestedAt:
                  row.latest_run_requested_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_run_requested_at),
                latestRunStartedAt:
                  row.latest_run_started_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_run_started_at),
                latestRunCompletedAt:
                  row.latest_run_completed_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_run_completed_at),
                latestUserMessageAt:
                  row.latest_user_message_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_user_message_at),
                latestUserAuthoredMessageAt:
                  row.latest_user_authored_message_at === null
                    ? null
                    : DateTime.makeUnsafe(row.latest_user_authored_message_at),
                activityRunStatus: null,
                activityRunStartedAt: null,
                pendingRuntimeRequest: null,
                pendingGuestMessageCount: pendingGuestMessageCount(thread.guestShare),
                pendingBackgroundTasks: derivePendingBackgroundWork({
                  latestRun:
                    latestRunId === null || status === "idle"
                      ? null
                      : { id: latestRunId, ordinal: 0, status },
                  providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
                  turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
                  activeProviderThreadId: thread.activeProviderThreadId,
                  hasActiveRun: false,
                  pullRequests: thread.pullRequests,
                }),
              } satisfies ProjectionSettlementCandidate;
            }),
          );
        }),
      )
      .pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

const getOpenRemoteDelegatedTasks: ProjectionStoreV2Shape["getOpenRemoteDelegatedTasks"] = sql<{
    readonly thread_id: string;
    readonly subagent_id: string;
  }>`
    SELECT thread_id, subagent_id FROM orchestration_v2_projection_subagents
    WHERE origin = 'app_owned'
      AND child_thread_id IS NULL
      AND json_type(payload_json, '$.remoteChild') = 'object'
      AND (
        json_type(payload_json, '$.result') = 'null'
        OR (
          json_extract(payload_json, '$.status') IN ('cancelled', 'interrupted')
          AND json_type(payload_json, '$.remoteChild.stoppedThere') IS NOT 'true'
        )
        OR json_type(payload_json, '$.remoteChild.stoppedThere') = 'false'
      )
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        parentThreadId: ThreadId.make(row.thread_id),
        taskId: NodeId.make(row.subagent_id),
      })),
    ),
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

const getThreadsWithPullRequests: ProjectionStoreV2Shape["getThreadsWithPullRequests"] =
    Effect.fn("ProjectionStore.getThreadsWithPullRequests")(
      function* (threadId) {
        const rows = yield* sql<PayloadRow>`
        SELECT payload_json
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND thread_id = ${threadId}`}
          AND json_extract(payload_json, '$.archivedAt') IS NULL
          AND json_array_length(payload_json, '$.pullRequests') > 0
        ORDER BY updated_at ASC, thread_id ASC
      `;
        return yield* Effect.forEach(rows, (row) =>
          decodeThreadPayload(row.payload_json).pipe(
            Effect.map((thread): ProjectionThreadPullRequests => ({
              id: thread.id,
              projectId: thread.projectId,
              lineage: thread.lineage,
              settledOverride: thread.settledOverride,
              settledAt: thread.settledAt,
              pullRequests: thread.pullRequests ?? [],
            })),
          ),
        );
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

  return { selectShellThreadRows, selectShellRunRows, selectShellRunItemCounts, selectShellItemCounts, selectShellProviderThreadRows, selectShellPendingTurnItemRows, runMapsByThreadId, shellItemCountMap, pendingBackgroundDataByThreadId, getSettlementCandidates, getOpenRemoteDelegatedTasks, getThreadsWithPullRequests };
});

export type SelectShellThreadRowsPart = ReturnType<typeof installSelectShellThreadRows> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installSelectShellThreadRows>;
