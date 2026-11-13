import { projectTurnItemForWire } from "../WireProjection.ts";
import { makeThreadFind } from "../ThreadFind.ts";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { IDLE_COMPACTION_TEXT, RunId, MessageId, ThreadId, TurnItemId, NodeId } from "@t3tools/contracts";
import { createOrchestrationV2TurnItemVisibility, isOrchestrationV2SupersededInterrupt } from "@t3tools/shared/orchestrationV2Timeline";
import * as Effect from "effect/Effect";
import { isThreadHistoryUserTurn, isConversationHistoryItem, missingInterruptRequests, deferWorkHistoryRows, selectDeferredWorkPage, olderHistoryPagePolicy, selectHistoryPageFromCursor, selectRecentTimelineWindow, THREAD_HISTORY_PAGE_POLICY } from "../threadHistoryPaging.ts";
import { ProjectionStoreReadError, ProjectionStoreThreadNotFoundError, type ProjectionRecords, type ProjectionStoreV2Error } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { decodeTurnItemPayload, encodeTimelineSources, inheritedRunFork, isProjectionStoreReadError, isProjectionStoreThreadNotFoundError, isTurnItemAtOrBeforeRun, makeForkMarkerTurnItem } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION, type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";
import type { GetUnreadableThreadIdsPart } from "./GetUnreadableThreadIds.ts";
import type { GetRuntimeRecoveryProjectionPart } from "./GetRuntimeRecoveryProjection.ts";
import type { GetCheckpointRollbackContextPart } from "./GetCheckpointRollbackContext.ts";
import type { TimelineIndexItem } from "./GetCheckpointRollbackContext.ts";
import type { TimelineIndexRow } from "./GetCheckpointRollbackContext.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart & GetUnreadableThreadIdsPart & GetRuntimeRecoveryProjectionPart & GetCheckpointRollbackContextPart;

export const installReadTimelineIndex = Effect.fnUntraced(function* (deps: Deps) {
  const { controlReadError, getThreadRecords, inlineWorkOutput, readProjection, sql } = deps;

const readTimelineIndex: (
    threadId: ThreadId,
    seen: ReadonlySet<ThreadId>,
    includePersistentOutput?: boolean,
  ) => Effect.Effect<
    {
      readonly records: ProjectionRecords<"runs" | "attempts">;
      readonly local: ReadonlyArray<TimelineIndexRow>;
      readonly visible: ReadonlyArray<TimelineIndexRow>;
    },
    ProjectionStoreV2Error
  > = Effect.fn("ProjectionStore.readTimelineIndex")(
    function* (threadId: ThreadId, seen: ReadonlySet<ThreadId>, includePersistentOutput = false) {
      const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
      const rows = yield* sql<{
        turn_item_id: string;
        run_id: string | null;
        node_id: string | null;
        parent_item_id: string | null;
        type: OrchestrationV2TurnItem["type"];
        input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
        created_by: "user" | "agent" | "system" | null;
        message_id: string | null;
        status: OrchestrationV2TurnItem["status"];
        ordinal: number;
        persistent_output: number;
        attempt_id: string | null;
        attempt_status: string | null;
      }>`SELECT item.turn_item_id, item.run_id, item.node_id, item.parent_item_id, item.type, item.status, item.ordinal,
        ${includePersistentOutput ? sql`attempt.attempt_id` : sql`NULL`} AS attempt_id,
        ${includePersistentOutput ? sql`attempt.status` : sql`NULL`} AS attempt_status,
        ${
          includePersistentOutput ? sql`CASE WHEN ${inlineWorkOutput} THEN 1 ELSE 0 END` : sql`0`
        } AS persistent_output,
        CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.inputIntent') END AS input_intent,
        CASE WHEN item.type = 'user_message' THEN json_extract(item.payload_json, '$.createdBy') END AS created_by,
        CASE WHEN item.type IN ('user_message', 'assistant_message') THEN json_extract(item.payload_json, '$.messageId') END AS message_id
      FROM orchestration_v2_projection_turn_items AS item
      ${
        includePersistentOutput
          ? sql`LEFT JOIN orchestration_v2_projection_nodes AS node ON node.node_id = item.node_id
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.attempt_id = (
        SELECT attempt_id FROM orchestration_v2_projection_run_attempts
        WHERE run_id = item.run_id AND root_node_id = COALESCE(node.root_node_id, item.node_id)
        ORDER BY attempt_ordinal DESC LIMIT 1
      )`
          : sql``
      }
      WHERE item.thread_id = ${threadId}
      ORDER BY item.ordinal ASC, item.turn_item_id ASC`;
      const runStatuses = new Map(records.runs.map((run) => [String(run.id), run.status]));
      const items: Array<TimelineIndexItem> = rows.map((row) => ({
        id: TurnItemId.make(row.turn_item_id),
        threadId,
        runId: row.run_id === null ? null : RunId.make(row.run_id),
        nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
        parentItemId: row.parent_item_id === null ? null : TurnItemId.make(row.parent_item_id),
        type: row.type,
        status: row.status,
        ordinal: row.ordinal,
        runStatus: row.run_id === null ? undefined : runStatuses.get(row.run_id),
        attemptId: row.attempt_id,
        attemptStatus: row.attempt_status,
        persistentOutput: row.persistent_output === 1,
        ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
        ...(row.created_by === null ? {} : { createdBy: row.created_by }),
        ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
      }));
      const local: Array<TimelineIndexRow> = items.map((item) => ({
        sourceThreadId: threadId,
        sourceItemId: item.id,
        visibility: "local",
        item,
      }));
      const isVisible = createOrchestrationV2TurnItemVisibility({
        runs: records.runs,
        attempts: records.attempts,
        items,
      });
      const visible = local.filter((row) => isVisible(row.item));
      const fork = inheritedRunFork(records.thread);
      if (fork === null || seen.has(fork.threadId)) return { records, local, visible };
      const source = yield* readTimelineIndex(
        fork.threadId,
        new Set([...seen, threadId]),
        includePersistentOutput,
      );
      const sourceRun = source.records.runs.find((run) => run.id === fork.runId);
      let inherited: Array<TimelineIndexRow> = [];
      if (sourceRun !== undefined) {
        const ordinals = new Map(source.records.runs.map((run) => [run.id, run.ordinal]));
        const sourceItems = source.local.map((row) => row.item);
        inherited = [
          ...source.visible.filter(
            (row) => row.item.threadId !== fork.threadId || row.item.type === "fork",
          ),
          ...source.local.filter(
            (row) =>
              !isOrchestrationV2SupersededInterrupt({
                item: row.item,
                attempts: source.records.attempts,
                items: sourceItems,
              }) &&
              isTurnItemAtOrBeforeRun({
                historyOrigin: source.records.thread.historyOrigin,
                itemRunId: row.item.runId,
                runOrdinalById: ordinals,
                sourceRunOrdinal: sourceRun.ordinal,
              }),
          ),
        ].map((row) => ({ ...row, visibility: "inherited" }));
      }
      const marker = makeForkMarkerTurnItem({
        targetProjection: records,
        sourceThreadId: fork.threadId,
        sourceRunId: fork.runId,
      });
      return {
        records,
        local,
        visible: [
          ...inherited,
          {
            sourceThreadId: fork.threadId,
            sourceItemId: marker.id,
            visibility: "synthetic" as const,
            item: marker,
            synthetic: marker,
          },
          ...visible,
        ],
      };
    },
    (effect, threadId, _seen) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      ),
  );

const { searchThread, searchThreadStream } = yield* makeThreadFind((threadId) =>
    readTimelineIndex(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
  );

const getThreadHistoryPage: ProjectionStoreV2Shape["getThreadHistoryPage"] = (
    threadId,
    cursor,
    throughEntryId,
    conversationOnly,
    workMode,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const index = yield* readTimelineIndex(threadId, new Set(), workMode !== undefined);
          if (index.records.thread.deletedAt !== null)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const revisions = yield* sql<{
            sequence: number;
          }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM orchestration_events WHERE application_event_version = 2
        AND aggregate_kind = 'thread' AND stream_id = ${threadId}`;
          const snapshotSequence = revisions[0]?.sequence ?? 0;
          const indexed = index.visible.map((row, position) => ({
            ...row,
            position,
            canonicalPosition: position,
          }));
          const historyItems = workMode === "deferred" ? deferWorkHistoryRows(indexed) : indexed;
          const selection = yield* Effect.try({
            try: () => {
              const policy = olderHistoryPagePolicy({ items: indexed, cursor, throughEntryId });
              const page =
                workMode === "work"
                  ? selectDeferredWorkPage({
                      items: indexed,
                      cursor,
                      throughEntryId,
                      snapshotSequence,
                      rowEncodedBytes: () => 0,
                    })
                  : selectHistoryPageFromCursor({
                      items: historyItems,
                      cursor,
                      snapshotSequence,
                      rowEncodedBytes: () => 0,
                      policy,
                    });
              return { policy, page };
            },
            catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
          });
          const { page } = selection;
          const policy = workMode === "work" ? THREAD_HISTORY_PAGE_POLICY : selection.policy;
          const end = (page.items.at(-1)?.canonicalPosition ?? -1) + 1;
          const hasUserTurns = index.visible
            .slice(0, end)
            .some((row) => isThreadHistoryUserTurn(row.item));
          const materialize = Effect.fn("ProjectionStore.materializeHistoryRows")(function* (
            rows: ReadonlyArray<(typeof indexed)[number]>,
          ) {
            if (rows.length === 0) return [];
            const sources = yield* encodeTimelineSources(
              rows
                .filter((row) => !row.synthetic)
                .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
            );
            const payloads = yield* sql<{
              thread_id: string;
              turn_item_id: string;
              payload_json: string;
            }>`
        SELECT item.thread_id, item.turn_item_id, item.payload_json
        FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
        ON item.thread_id = json_extract(wanted.value, '$.threadId')
          AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
            const byIdentity = new Map(
              payloads.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row.payload_json]),
            );
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const payload = byIdentity.get(`${row.sourceThreadId}:${row.sourceItemId}`);
                const item =
                  row.synthetic ??
                  (payload === undefined
                    ? yield* new ProjectionStoreReadError({ threadId })
                    : yield* decodeTurnItemPayload(payload));
                return {
                  position: row.canonicalPosition,
                  visibility: row.visibility,
                  sourceThreadId: row.sourceThreadId,
                  sourceItemId: row.sourceItemId,
                  item: projectTurnItemForWire(
                    row.item.deferredWork === undefined
                      ? item
                      : { ...item, deferredWork: row.item.deferredWork },
                  ),
                };
              }),
            );
          });
          const items = yield* materialize(
            conversationOnly && hasUserTurns
              ? page.items.filter((row) => isConversationHistoryItem(row.item))
              : page.items,
          );
          const bounded = selectRecentTimelineWindow({ items, snapshotSequence, policy });
          const requests =
            workMode === "work"
              ? []
              : yield* materialize(missingInterruptRequests(indexed, bounded.items));
          const pageItems = [...requests, ...bounded.items].map((row, position) => ({
            ...row,
            position,
          }));
          return {
            snapshotSequence,
            items: conversationOnly
              ? pageItems.filter((row) => isConversationHistoryItem(row.item))
              : pageItems,
            nextCursor: bounded.hasMoreHistory ? bounded.nextCursor : page.nextCursor,
            hasMoreHistory: bounded.hasMoreHistory || page.hasMoreHistory,
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getTimelinePage: ProjectionStoreV2Shape["getTimelinePage"] = (threadId, options) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const index = yield* readTimelineIndex(threadId, new Set());
          const attachmentOwners =
            options.attachmentId === undefined
              ? undefined
              : new Set(
                  (yield* sql<{ thread_id: string; turn_item_id: string }>`
        SELECT item.thread_id, item.turn_item_id
        FROM orchestration_v2_projection_turn_items AS item,
          json_each(item.payload_json, '$.attachments') AS attachment
        WHERE item.thread_id IN ${sql.in([...new Set(index.visible.map((row) => row.sourceThreadId))])}
          AND item.type = 'user_message'
          AND json_extract(attachment.value, '$.id') = ${options.attachmentId}`).map(
                    (row) => `${row.thread_id}:${row.turn_item_id}`,
                  ),
                );
          const matching = index.visible
            .map((row, position) => ({ ...row, position }))
            .filter((row) =>
              options.itemId === undefined
                ? row.position > (options.afterPosition ?? -1) &&
                  (options.view === "activity" ||
                    ["user_message", "assistant_message", "proposed_plan"].includes(
                      row.item.type,
                    ))
                : row.sourceItemId === options.itemId,
            )
            .filter(
              (row) => attachmentOwners?.has(`${row.sourceThreadId}:${row.sourceItemId}`) ?? true,
            );
          const page = matching.slice(0, options.limit);
          const sources = yield* encodeTimelineSources(
            page
              .filter((row) => row.synthetic === undefined)
              .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
          );
          const payloads = yield* sql<{
            thread_id: string;
            turn_item_id: string;
            payload_json: string;
          }>`
        SELECT item.thread_id, item.turn_item_id, item.payload_json
        FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
        ON item.thread_id = json_extract(wanted.value, '$.threadId')
          AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
          const byIdentity = new Map(
            payloads.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row.payload_json]),
          );
          const items = yield* Effect.forEach(page, (row) =>
            Effect.gen(function* () {
              if (row.synthetic !== undefined)
                return {
                  position: row.position,
                  sourceThreadId: row.sourceThreadId,
                  sourceItemId: row.sourceItemId,
                  visibility: row.visibility,
                  item: row.synthetic,
                };
              const payload = byIdentity.get(`${row.sourceThreadId}:${row.sourceItemId}`);
              if (payload === undefined)
                return yield* new ProjectionStoreReadError({
                  threadId,
                  cause: "Timeline item disappeared during snapshot",
                });
              const item = yield* decodeTurnItemPayload(payload).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectionStoreReadError({ threadId: row.sourceThreadId, cause }),
                ),
              );
              return {
                position: row.position,
                sourceThreadId: row.sourceThreadId,
                sourceItemId: row.sourceItemId,
                visibility: row.visibility,
                item,
              };
            }),
          );
          return {
            items,
            totalItems: index.visible.length,
            hasMore: matching.length > page.length,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

const getThreadSnapshotWindow: ProjectionStoreV2Shape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const historyAnchor =
            options.anchorItemId === undefined
              ? undefined
              : {
                  itemId: options.anchorItemId,
                  threadId:
                    options.anchorThreadId ??
                    (yield* sql<{ readonly thread_id: string }>`
                      SELECT thread_id
                      FROM orchestration_v2_projection_turn_items
                      WHERE turn_item_id = ${options.anchorItemId}
                      LIMIT 1
                    `).map((row) => ThreadId.make(row.thread_id))[0] ??
                    threadId,
                };
          const projection = yield* readProjection(threadId, new Set(), {
            rowLimit: options.rowLimit,
            userTurnLimit: options.userTurnLimit,
            deferWork: options.deferWork,
            ...(historyAnchor?.threadId === threadId
              ? { anchorItemId: historyAnchor.itemId }
              : {}),
            ...(historyAnchor === undefined ? {} : { historyAnchor }),
          });
          const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
          `;
          return {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
            projection,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

const isIdleCompactionMessage = (alias: string) => {
    const payload = sql.literal(`${alias}.payload_json`);
    return sql`(
      ${sql.literal(`${alias}.role`)} = 'user'
      AND lower(trim(json_extract(${payload}, '$.text'),
        char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195,
          8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)
      )) = ${IDLE_COMPACTION_TEXT}
      AND coalesce(json_array_length(${payload}, '$.attachments'), 0) = 0
      AND (
        json_extract(${payload}, '$.idleCompaction') IS NOT NULL
        OR (
          json_extract(${payload}, '$.createdBy') = 'agent'
          AND json_extract(${payload}, '$.creationSource') = 'server'
        )
      )
    )`;
  };

const isSilentShellRun = (alias: string) => {
    const run = sql.literal(alias);
    return sql`(
      ${run}.status <> 'failed'
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages prompt
        WHERE prompt.message_id = json_extract(${run}.payload_json, '$.userMessageId')
          AND ${isIdleCompactionMessage("prompt")}
      ) AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items compaction
        WHERE compaction.thread_id = ${run}.thread_id AND compaction.run_id = ${run}.run_id
          AND compaction.type = 'compaction'
          AND compaction.status = 'failed'
      )
    )`;
  };

  return { readTimelineIndex, searchThread, searchThreadStream, getThreadHistoryPage, getTimelinePage, getThreadSnapshotWindow, isIdleCompactionMessage, isSilentShellRun };
});

export type ReadTimelineIndexPart = ReturnType<typeof installReadTimelineIndex> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installReadTimelineIndex>;
