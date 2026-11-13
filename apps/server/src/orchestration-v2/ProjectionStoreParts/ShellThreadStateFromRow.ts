import { threadErrorSummary } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem, GuestShareId } from "@t3tools/contracts";
import { RunId, ThreadId, ProjectId } from "@t3tools/contracts";
import { deriveBlockedOnThreadWait, derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
// @effect-diagnostics anyUnknownInErrorContext:off
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION, type PayloadRow, type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { ProjectionStoreReadError, ProjectionStoreSetupError, type ActiveShellIndexEntry, type ShellSnapshotOptions } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { activeProviderGoalForShell, decodePullRequestThread, decodeRuntimeRequestPayload, decodeThreadPayload, decodeTurnItemPayload, linkCardStillAsks, pendingRuntimeRequestSummary, providerInstanceHistoryForShell, secretRequestAsPendingInput, type ShellThreadRow } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { shellForkSourceIds, shellFromState, shellStatusFromStoredRunStatus, type ShellThreadState, visibleItemCountForShell } from "../ProjectionStorePrelude/ThreadShellFromProjection.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";
import type { GetUnreadableThreadIdsPart } from "./GetUnreadableThreadIds.ts";
import type { GetRuntimeRecoveryProjectionPart } from "./GetRuntimeRecoveryProjection.ts";
import type { GetCheckpointRollbackContextPart } from "./GetCheckpointRollbackContext.ts";
import type { ReadTimelineIndexPart } from "./ReadTimelineIndex.ts";
import type { SelectShellThreadRowsPart } from "./SelectShellThreadRows.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart & GetUnreadableThreadIdsPart & GetRuntimeRecoveryProjectionPart & GetCheckpointRollbackContextPart & ReadTimelineIndexPart & SelectShellThreadRowsPart;

export const installShellThreadStateFromRow = Effect.fnUntraced(function* (deps: Deps) {
  const { pendingBackgroundDataByThreadId, runMapsByThreadId, selectShellItemCounts, selectShellPendingTurnItemRows, selectShellProviderThreadRows, selectShellRunItemCounts, selectShellRunRows, selectShellThreadRows, shellItemCountMap, sql } = deps;

const getThreadWorktreePaths: ProjectionStoreV2Shape["getThreadWorktreePaths"] = (options) =>
    sql<{ readonly thread_id: string; readonly worktree_path: string }>`
      SELECT thread_id, json_extract(payload_json, '$.worktreePath') AS worktree_path
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        ${options?.includeArchived === true ? sql`` : sql`AND json_extract(payload_json, '$.archivedAt') IS NULL`}
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          threadId: ThreadId.make(row.thread_id),
          worktreePath: row.worktree_path,
        })),
      ),
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

const shellThreadStateFromRow =
    /* Runs once per shell row; the enclosing snapshot or thread read owns the span. */
    Effect.fnUntraced(function* (input: {
      readonly row: ShellThreadRow;
      readonly runOrdinalsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly itemCountsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly shellItemCountsByThreadId: ReadonlyMap<
        ThreadId,
        { readonly itemCount: number; readonly runlessItemCount: number }
      >;
      readonly providerThreadsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>
      >;
      readonly pendingTurnItemsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2TurnItem>
      >;
    }) {
      const {
        row,
        runOrdinalsByThreadId,
        itemCountsByThreadId,
        shellItemCountsByThreadId,
        providerThreadsByThreadId,
        pendingTurnItemsByThreadId,
      } = input;
      const thread = yield* decodeThreadPayload(row.payload_json);
      const latestUserAuthoredMessageAt =
        row.latest_user_authored_message_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_user_authored_message_at);
      const waitingCards = [
        row.pending_secret_request_payload_json === null
          ? null
          : yield* decodeTurnItemPayload(row.pending_secret_request_payload_json),
        row.pending_link_request_payload_json === null
          ? null
          : yield* decodeTurnItemPayload(row.pending_link_request_payload_json),
      ]
        .filter((item) => item !== null)
        .filter(
          (item) =>
            item.type !== "link_request" || linkCardStillAsks(item, latestUserAuthoredMessageAt),
        );
      let pendingRuntimeRequest =
        row.pending_request_payload_json !== null
          ? pendingRuntimeRequestSummary(
              yield* decodeRuntimeRequestPayload(row.pending_request_payload_json),
            )
          : null;
      if (
        (pendingRuntimeRequest === null || pendingRuntimeRequest.blocking === false) &&
        waitingCards.length > 0
      ) {
        pendingRuntimeRequest =
          secretRequestAsPendingInput(
            waitingCards.toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
            )[0] ?? null,
          ) ?? pendingRuntimeRequest;
      }
      let terminalFailureItem =
        row.terminal_failure_payload_json === null
          ? null
          : yield* decodeTurnItemPayload(row.terminal_failure_payload_json);
      let latestRunId = row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
      let latestRunStatus = shellStatusFromStoredRunStatus(row.latest_run_status);
      let latestRunRequestedAt =
        row.latest_run_requested_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_run_requested_at);
      let latestRunStartedAt =
        row.latest_run_started_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_run_started_at);
      let latestRunCompletedAt =
        row.latest_run_completed_at === null
          ? null
          : DateTime.makeUnsafe(row.latest_run_completed_at);
      let latestRunStopRequested = row.latest_run_stop_requested === 1;
      if (row.blocking_run_id !== null && row.blocking_failure_payload_json !== null) {
        const blockingFailure = yield* decodeTurnItemPayload(
          row.blocking_failure_payload_json,
        ).pipe(Effect.orElseSucceed(() => null));
        const blocksQueue =
          threadErrorSummary(
            blockingFailure?.type === "error" ? blockingFailure.failure : null,
            row.last_error,
          ).lastErrorClass === "usage_limit";
        if (blocksQueue && blockingFailure !== null) {
          terminalFailureItem = blockingFailure;
          latestRunId = RunId.make(row.blocking_run_id);
          latestRunStopRequested = row.blocking_run_stop_requested === 1;
          latestRunStatus = "failed";
          latestRunRequestedAt =
            row.blocking_run_requested_at === null
              ? null
              : DateTime.makeUnsafe(row.blocking_run_requested_at);
          latestRunStartedAt =
            row.blocking_run_started_at === null
              ? null
              : DateTime.makeUnsafe(row.blocking_run_started_at);
          latestRunCompletedAt =
            row.blocking_run_completed_at === null
              ? null
              : DateTime.makeUnsafe(row.blocking_run_completed_at);
        }
      }
      const pendingBackgroundTasks = [
        ...derivePendingBackgroundWork({
          latestRun:
            latestRunId === null || latestRunStatus === "idle"
              ? null
              : {
                  id: latestRunId,
                  ordinal: 0,
                  status: latestRunStatus,
                },
          providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
          turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
          activeProviderThreadId: thread.activeProviderThreadId,
          hasActiveRun: row.active_run_id !== null,
          pullRequests: thread.pullRequests,
        }),
      ];
      return {
        thread,
        latestRunId,
        latestRunStatus,
        latestRunRequestedAt,
        latestRunStartedAt,
        latestRunCompletedAt,
        latestRunStopRequested,
        activeRunId: row.active_run_id === null ? null : RunId.make(row.active_run_id),
        blockedOnThreadWait: deriveBlockedOnThreadWait({
          activeRun:
            row.active_run_id === null || row.active_run_status !== "running"
              ? null
              : { id: RunId.make(row.active_run_id), status: "running" },
          turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
        }),
        activityRunStartedAt:
          row.activity_run_started_at === null
            ? null
            : DateTime.makeUnsafe(row.activity_run_started_at),
        activityRunStatus:
          row.activity_run_status === "preparing" ||
          row.activity_run_status === "starting" ||
          row.activity_run_status === "running" ||
          row.activity_run_status === "waiting"
            ? row.activity_run_status
            : null,
        ...threadErrorSummary(
          terminalFailureItem?.type === "error" ? terminalFailureItem.failure : null,
          row.last_error,
        ),
        pendingRuntimeRequest,
        latestUserMessageAt:
          row.latest_user_message_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_user_message_at),
        latestUserAuthoredMessageAt,
        hasActionableProposedPlan: row.has_actionable_proposed_plan === 1,
        pendingBackgroundTasks,
        providerInstanceHistory: providerInstanceHistoryForShell({
          threadId: thread.id,
          providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
        }),
        goal: activeProviderGoalForShell(
          providerThreadsByThreadId.get(thread.id) ?? [],
          thread.activeProviderThreadId,
        ),
        itemCount: shellItemCountsByThreadId.get(thread.id)?.itemCount ?? 0,
        runlessItemCount: shellItemCountsByThreadId.get(thread.id)?.runlessItemCount ?? 0,
        updatedAt: thread.updatedAt,
        runOrdinalById: runOrdinalsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
        itemCountByRunId: itemCountsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
      } satisfies ShellThreadState;
    });

const shellSnapshotReadError = (cause: unknown) =>
    new ProjectionStoreReadError({ threadId: ThreadId.make("thread:shell"), cause });

const readShellSnapshotRows = Effect.fn("ProjectionStore.readShellSnapshotRows")(function* (
    options: ShellSnapshotOptions | undefined,
  ) {
    const targetThreadRows = yield* selectShellThreadRows(undefined, options);
    const targetThreadIds = new Set(targetThreadRows.map((row) => ThreadId.make(row.thread_id)));
    const rowsByThreadId = new Map(
      targetThreadRows.map((row) => [ThreadId.make(row.thread_id), row] as const),
    );
    const pendingSourceIds = targetThreadRows.flatMap((row) =>
      row.forked_from_run_source_thread_id === null
        ? []
        : [ThreadId.make(row.forked_from_run_source_thread_id)],
    );
    while (pendingSourceIds.length > 0) {
      const sourceId = pendingSourceIds.pop();
      if (sourceId === undefined || rowsByThreadId.has(sourceId)) continue;
      const source = (yield* selectShellThreadRows(sourceId))[0];
      if (source === undefined) continue;
      rowsByThreadId.set(sourceId, source);
      if (source.forked_from_run_source_thread_id !== null) {
        pendingSourceIds.push(ThreadId.make(source.forked_from_run_source_thread_id));
      }
    }
    const threadRows = [...rowsByThreadId.values()];
    const threadIds = [...rowsByThreadId.keys()];
    const forkSourceIds = shellForkSourceIds(threadRows);
    const readForThreadIds = <A>(
      read: (ids: ReadonlyArray<ThreadId>) => Effect.Effect<ReadonlyArray<A>, unknown>,
      ids: ReadonlyArray<ThreadId> = threadIds,
    ) => (ids.length === 0 ? Effect.succeed([] as ReadonlyArray<A>) : read(ids));
    const [
      runRows,
      itemCountRows,
      shellItemCountRows,
      sequenceRows,
      providerThreadRows,
      pendingTurnItemRows,
    ] = yield* Effect.all([
      readForThreadIds(selectShellRunRows, forkSourceIds),
      readForThreadIds(selectShellRunItemCounts, forkSourceIds),
      readForThreadIds(selectShellItemCounts),
      sql<{ readonly snapshot_sequence: number | null }>`
      SELECT MAX(sequence) AS snapshot_sequence
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
    `,
      readForThreadIds(selectShellProviderThreadRows),
      readForThreadIds((ids) =>
        selectShellPendingTurnItemRows(
          ids,
          threadRows.flatMap((row) =>
            row.active_run_id !== null && row.active_run_status === "running"
              ? [row.active_run_id]
              : [],
          ),
        ),
      ),
    ]);
    return {
      targetThreadIds,
      threadRows,
      runRows,
      itemCountRows,
      shellItemCountRows,
      sequenceRows,
      providerThreadRows,
      pendingTurnItemRows,
    };
  });

const decodeShellSnapshot = Effect.fn("ProjectionStore.decodeShellSnapshot")(function* ({
    targetThreadIds,
    threadRows,
    runRows,
    itemCountRows,
    shellItemCountRows,
    sequenceRows,
    providerThreadRows,
    pendingTurnItemRows,
  }: Effect.Success<ReturnType<typeof readShellSnapshotRows>>) {
    const { runOrdinalsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
      runRows,
      itemCountRows,
    });
    const shellItemCountsByThreadId = shellItemCountMap(shellItemCountRows);
    const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
      yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });
    const states = yield* Effect.forEach(threadRows, (row) =>
      shellThreadStateFromRow({
        row,
        runOrdinalsByThreadId,
        itemCountsByThreadId,
        shellItemCountsByThreadId,
        providerThreadsByThreadId,
        pendingTurnItemsByThreadId,
      }),
    );
    const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));

    const shells = states
      .filter((state) => targetThreadIds.has(state.thread.id))
      .map((state) =>
        shellFromState({
          state,
          visibleItemCount: visibleItemCountForShell({
            threadId: state.thread.id,
            statesByThreadId,
          }),
        }),
      );

    return {
      schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
      snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0,
      threads: shells.filter((thread) => thread.archivedAt === null),
      archivedThreads: shells.filter((thread) => thread.archivedAt !== null),
    };
  }, Effect.mapError(shellSnapshotReadError));

const readShellSnapshot: ProjectionStoreV2Shape["readShellSnapshot"] = (options) =>
    readShellSnapshotRows(options).pipe(
      Effect.mapError(shellSnapshotReadError),
      Effect.map(decodeShellSnapshot),
    );

const getPullRequestSnapshot: ProjectionStoreV2Shape["getPullRequestSnapshot"] = Effect.fn(
    "ProjectionStore.getPullRequestSnapshot",
  )(function* ({ threadId, unsettledOnly = false }) {
    const { rows, sequenceRows } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
        SELECT t.payload_json FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL${
          threadId === undefined
            ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
            : sql` AND t.thread_id = ${threadId}`
        }${
          unsettledOnly
            ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL
              AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
            : sql``
        }
        ORDER BY t.updated_at ASC, t.thread_id ASC
      `;
        const sequenceRows = yield* sql<{ readonly snapshot_sequence: number | null }>`
        SELECT MAX(sequence) AS snapshot_sequence FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      `;
        return { rows, sequenceRows };
      }),
    );
    // Decode after releasing the reader, keeping rows and sequence from the same transaction.
    const threads = yield* Effect.forEach(rows, (row) =>
      decodePullRequestThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, pullRequests: threadPullRequestsOf(thread) })),
      ),
    );
    return { snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0, threads };
  }, Effect.mapError(shellSnapshotReadError));

const getShellSnapshot: ProjectionStoreV2Shape["getShellSnapshot"] = (options) =>
    sql
      .withTransaction(readShellSnapshotRows(options))
      .pipe(Effect.mapError(shellSnapshotReadError), Effect.flatMap(decodeShellSnapshot));

const listActiveSubagentThreadIds = Effect.fn("ProjectionStore.listActiveSubagentThreadIds")(
    function* () {
      const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.archivedAt') IS NULL
        AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
    `;
      return rows.map((row) => ThreadId.make(row.thread_id));
    },
    Effect.mapError(shellSnapshotReadError),
  );

const countThreads = Effect.fn("ProjectionStore.countThreads")(function* () {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
    `;
    return rows[0]?.count ?? 0;
  }, Effect.mapError(shellSnapshotReadError));

const listActiveShellIndex = Effect.fn("ProjectionStore.listActiveShellIndex")(function* () {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly relationship_to_parent: string | null;
      readonly parent_thread_id: string | null;
      readonly root_thread_id: string;
      readonly side_chat: number | null;
      readonly settled_override: string | null;
      readonly settled_at: string | null;
      readonly pinned_at: string | null;
      readonly snoozed_until: string | null;
      readonly may_be_live: number;
    }>`
      SELECT
        t.thread_id,
        t.project_id,
        json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        json_extract(t.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
        json_extract(t.payload_json, '$.lineage.sideChat') AS side_chat,
        json_extract(t.payload_json, '$.settledOverride') AS settled_override,
        json_extract(t.payload_json, '$.settledAt') AS settled_at,
        json_extract(t.payload_json, '$.pinnedAt') AS pinned_at,
        json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
        -- A superset of isLiveSubagentShell: the sources of its run status, pending request,
        -- and pending background work.
        (
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = t.thread_id
              AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          )
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runtime_requests request
            WHERE request.thread_id = t.thread_id AND request.status = 'pending'
          )
          -- Same predicates as the shell's pending item and link reads, for their partial indexes.
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items item
            WHERE item.thread_id = t.thread_id
              AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
          )
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items link_request
            WHERE link_request.thread_id = t.thread_id
              AND link_request.type = 'link_request' AND link_request.status = 'waiting'
          )
          OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_provider_threads provider_thread
            WHERE provider_thread.thread_id = t.thread_id
              AND json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
          )
          OR EXISTS (
            SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
            WHERE json_type(link.value, '$.watch') IS NOT NULL
          )
        ) AS may_be_live
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.archivedAt') IS NULL
      ORDER BY t.updated_at ASC, t.thread_id ASC
    `;
    return rows.map((row): ActiveShellIndexEntry => ({
      id: ThreadId.make(row.thread_id),
      projectId: ProjectId.make(row.project_id),
      lineage: {
        parentThreadId:
          row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
        relationshipToParent:
          row.relationship_to_parent === "fork" || row.relationship_to_parent === "subagent"
            ? row.relationship_to_parent
            : null,
        rootThreadId: ThreadId.make(row.root_thread_id),
        ...(row.side_chat === null ? {} : { sideChat: row.side_chat === 1 }),
      },
      settledOverride:
        row.settled_override === "settled" || row.settled_override === "active"
          ? row.settled_override
          : null,
      settledAt: row.settled_at === null ? null : DateTime.makeUnsafe(row.settled_at),
      pinnedAt: row.pinned_at === null ? null : DateTime.makeUnsafe(row.pinned_at),
      snoozedUntil: row.snoozed_until === null ? null : DateTime.makeUnsafe(row.snoozed_until),
      mayBeLive: row.may_be_live === 1,
    }));
  }, Effect.mapError(shellSnapshotReadError));

const findGuestShareThreadId = Effect.fn("ProjectionStore.findGuestShareThreadId")(function* (
    shareId: GuestShareId,
  ) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.guestShare.id') = ${shareId}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id);
  }, Effect.mapError(shellSnapshotReadError));

const listOlderSettledThreads: ProjectionStoreV2Shape["listOlderSettledThreads"] = Effect.fn(
    "ProjectionStore.listOlderSettledThreads",
  )(function* ({ before, projectIds, limit }) {
    // ISO strings in one format, so string order is time order.
    const older = sql`
      SELECT t.thread_id, t.project_id,
        json_extract(t.payload_json, '$.settledAt') AS settled_at
      FROM orchestration_v2_projection_threads t
      WHERE t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
        AND json_extract(t.payload_json, '$.settledOverride') = 'settled'
        AND json_extract(t.payload_json, '$.settledAt') IS NOT NULL${
          projectIds === undefined ? sql`` : sql` AND t.project_id IN ${sql.in(projectIds)}`
        }
    `;
    const belowCursor =
      before.threadId === undefined
        ? sql`older.settled_at < ${before.settledAt}`
        : sql`(older.settled_at < ${before.settledAt}
            OR (older.settled_at = ${before.settledAt} AND older.thread_id > ${before.threadId}))`;
    const pageRows =
      limit === 0
        ? []
        : yield* sql<{ readonly thread_id: string }>`
            WITH older AS (${older})
            SELECT older.thread_id FROM older
            WHERE ${belowCursor}
            ORDER BY older.settled_at DESC, older.thread_id ASC
            LIMIT ${limit}
          `;
    const countRows =
      limit !== 0
        ? []
        : yield* sql<{ readonly project_id: string; readonly count: number }>`
            WITH older AS (${older})
            SELECT older.project_id, COUNT(*) AS count FROM older
            WHERE ${belowCursor}
            GROUP BY older.project_id
          `;
    return {
      threadIds: pageRows.map((row) => ThreadId.make(row.thread_id)),
      counts: countRows.map((row) => ({
        projectId: ProjectId.make(row.project_id),
        count: row.count,
      })),
    };
  }, Effect.mapError(shellSnapshotReadError));

  return { getThreadWorktreePaths, shellThreadStateFromRow, shellSnapshotReadError, readShellSnapshotRows, decodeShellSnapshot, readShellSnapshot, getPullRequestSnapshot, getShellSnapshot, listActiveSubagentThreadIds, countThreads, listActiveShellIndex, findGuestShareThreadId, listOlderSettledThreads };
});

export type ShellThreadStateFromRowPart = ReturnType<typeof installShellThreadStateFromRow> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installShellThreadStateFromRow>;
