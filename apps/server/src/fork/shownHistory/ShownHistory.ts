import {
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  type DisplayEvent,
  displayEventFromTurnItem,
  foldCores,
  SEND_TO_USER_TOOL_NAME,
  SUB_THREAD_WINDOW_CORES,
} from "@t3tools/shared/displayModes";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  type SelectTimelinePageResult,
  THREAD_HISTORY_MAX_RAW_TURNS,
  type ThreadHistoryCursorPayload,
} from "../../orchestration-v2/threadHistoryPaging.ts";
import { projectTurnItemForWire } from "../../orchestration-v2/WireProjection.ts";

/** A row's place in its thread's history: rows sort by ordinal, then by item id. */
export interface ShownKey {
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly itemId: TurnItemId;
}

/** A row that a display mode shows, and what it shows. */
interface ShownRow extends ShownKey {
  readonly rowid: number;
  readonly item: OrchestrationV2TurnItem;
  readonly event: Exclude<DisplayEvent, { readonly type: "other" }>;
}

/** The rows of a window or page, newest first, and the newest shown row older than them. */
export interface ShownWalk {
  readonly rows: ReadonlyArray<ShownRow>;
  readonly next: ShownKey | null;
}

/** Where a read starts: rows older than this key, or also the row itself when inclusive. */
interface ShownBound {
  readonly ordinal: number;
  readonly itemId: string;
  readonly inclusive: boolean;
}

/** One thread's stretch of a history, read newest first from `from`. */
interface ShownSegment {
  readonly threadId: ThreadId;
  readonly from: ShownBound;
  /** An inherited stretch keeps the rows at or before the fork run, as isTurnItemAtOrBeforeRun does. */
  readonly inherited: { readonly runOrdinal: number; readonly runlessRows: boolean } | null;
}

/** The row a targeted page must reach: its segment and its key there. */
interface ShownTarget {
  readonly index: number;
  readonly ordinal: number;
  readonly itemId: string;
}

/** A walk stops once it holds `minCores` messages, or at a cap. */
interface ShownLimits {
  readonly minCores: number;
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxRuns: number;
}

const WINDOW_LIMITS: ShownLimits = {
  // A send answers only a message among the latest SUB_THREAD_WINDOW_CORES, so a live reply finds it.
  minCores: SUB_THREAD_WINDOW_CORES,
  maxRows: 600,
  maxBytes: 512 * 1024,
  // A run's records come along outside the byte cap; Normal stops at as many turns.
  maxRuns: THREAD_HISTORY_MAX_RAW_TURNS,
};
const PAGE_LIMITS: ShownLimits = {
  minCores: 100,
  maxRows: 1_000,
  maxBytes: 1_048_576,
  maxRuns: Number.POSITIVE_INFINITY,
};
const TARGETED_PAGE_LIMITS: ShownLimits = { ...PAGE_LIMITS, maxRows: 2_000, maxBytes: 2_097_152 };

const BATCH_ROWS = 32;
// TurnItemPositionStore numbers a run's items from runOrdinal * 1_000_000.
const RUN_ORDINAL_SPAN = 1_000_000;
const NEWEST: ShownBound = { ordinal: Number.MAX_SAFE_INTEGER, itemId: "", inclusive: false };

const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeForkFields = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2AppThreadJson.mapFields(({ forkedFrom, lineage, historyOrigin, deletedAt }) => ({
      forkedFrom,
      lineage,
      historyOrigin,
      deletedAt,
    })),
  ),
);

/** ProjectionStore's inheritedRunFork, passed in so this module never imports ProjectionStore. */
type ForkOf = (
  thread: Pick<OrchestrationV2AppThread, "forkedFrom" | "lineage">,
) => { readonly threadId: ThreadId; readonly runId: RunId } | null;

/** A shown cursor is upstream's history cursor, at the row the next page starts with, plus `fv`. */
type ShownCursorPayload = ThreadHistoryCursorPayload & { readonly fv: "shown" };

function encodeShownCursor(snapshotSequence: number, key: ShownKey): string {
  const payload: ShownCursorPayload = {
    v: 1,
    seq: snapshotSequence,
    st: key.threadId,
    si: key.itemId,
    p: key.ordinal,
    inclusive: true,
    fv: "shown",
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The row a shown cursor starts at; null for any other cursor, which pages the Normal way. */
export function shownCursorOf(cursor: string): ShownKey | null {
  const payload = Result.getOrNull(Result.try(() => decodeThreadHistoryCursor(cursor)));
  return payload !== null && "fv" in payload && payload.fv === "shown" && payload.inclusive === true
    ? {
        threadId: ThreadId.make(payload.st),
        ordinal: payload.p,
        itemId: TurnItemId.make(payload.si),
      }
    : null;
}

/**
 * A `send_to_user` or `replace_send_to_user` call: a tool name that holds `send_to_user`, a superset
 * of the names resolveT3McpToolId takes, completion labels and namespaces included.
 */
export const sendCallSql = (sql: SqlClient.SqlClient) =>
  sql`(item.type = 'dynamic_tool'
    AND json_extract(item.payload_json, '$.toolName') LIKE ${`%${SEND_TO_USER_TOOL_NAME}%`})`;

/** The rows a display mode can show: messages the user typed (isUserTypedMessage) and send calls. */
const shownCandidateSql = (sql: SqlClient.SqlClient) => sql`(
  (item.type = 'user_message'
    AND json_extract(item.payload_json, '$.createdBy') = 'user'
    AND json_extract(item.payload_json, '$.creationSource') IN ('web', 'mobile')
    AND json_extract(item.payload_json, '$.scheduledTaskId') IS NULL
    AND json_extract(item.payload_json, '$.senderThreadId') IS NULL
    AND json_extract(item.payload_json, '$.idleCompaction') IS NULL)
  OR ${sendCallSql(sql)})`;

// A thread's own rows follow the eligible rule of ProjectionStore.retainedWindowRows; an inherited
// stretch only the fork cutoff.
const segmentVisible = (sql: SqlClient.SqlClient, segment: ShownSegment) =>
  segment.inherited === null
    ? sql`(run.status IS NULL OR run.status <> 'rolled_back')
        AND NOT (item.type = 'user_message'
          AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
          AND run.status IS 'cancelled')`
    : sql`(run.ordinal <= ${segment.inherited.runOrdinal}
        OR (item.run_id IS NULL AND ${segment.inherited.runlessRows ? 1 : 0} = 1))`;

interface CandidateRow {
  readonly item_rowid: number;
  readonly turn_item_id: string;
  readonly ordinal: number;
  readonly payload_json: string;
}

const readCandidates = (sql: SqlClient.SqlClient, segment: ShownSegment, from: ShownBound) =>
  sql<CandidateRow>`
    SELECT item.rowid AS item_rowid, item.turn_item_id, item.ordinal, item.payload_json
    FROM orchestration_v2_projection_turn_items AS item
    LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
    WHERE item.thread_id = ${segment.threadId}
      AND item.ordinal <= ${from.ordinal}
      AND (item.ordinal < ${from.ordinal}
        OR item.turn_item_id ${sql.literal(from.inclusive ? "<=" : "<")} ${from.itemId})
      AND ${shownCandidateSql(sql)}
      AND ${segmentVisible(sql, segment)}
    ORDER BY item.ordinal DESC, item.turn_item_id DESC
    LIMIT ${BATCH_ROWS}
  `;

const isBelow = (key: { readonly ordinal: number; readonly itemId: string }, bound: ShownBound) =>
  key.ordinal < bound.ordinal ||
  (key.ordinal === bound.ordinal &&
    (bound.inclusive ? key.itemId <= bound.itemId : key.itemId < bound.itemId));

/**
 * The thread's history as stretches, newest first: its own rows, then each fork ancestor's rows up
 * to the fork run. Null when the thread is missing or deleted.
 */
const shownSegments = Effect.fn("ShownHistory.segments")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  forkOf: ForkOf,
) {
  const readThread = (id: ThreadId) =>
    sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${id} LIMIT 1
    `.pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.succeed(null) : decodeForkFields(row.payload_json),
      ),
    );
  let thread = yield* readThread(threadId);
  if (thread === null || thread.deletedAt !== null) return null;
  const segments: ShownSegment[] = [{ threadId, from: NEWEST, inherited: null }];
  const seen = new Set<ThreadId>([threadId]);
  for (
    let fork = forkOf(thread);
    fork !== null && !seen.has(fork.threadId);
    fork = forkOf(thread)
  ) {
    seen.add(fork.threadId);
    const source = yield* readThread(fork.threadId);
    const [run] = yield* sql<{ readonly ordinal: number }>`
      SELECT ordinal FROM orchestration_v2_projection_runs
      WHERE thread_id = ${fork.threadId} AND run_id = ${fork.runId} LIMIT 1
    `;
    if (source === null || run === undefined) break;
    segments.push({
      threadId: fork.threadId,
      from: { ordinal: (run.ordinal + 1) * RUN_ORDINAL_SPAN, itemId: "", inclusive: false },
      inherited: { runOrdinal: run.ordinal, runlessRows: source.historyOrigin === "v1_import" },
    });
    thread = source;
  }
  return segments;
});

/** The segments from `key` on, the row itself included; null when `key` is in none of them. */
function segmentsFrom(
  segments: ReadonlyArray<ShownSegment>,
  key: ShownKey,
): ReadonlyArray<ShownSegment> | null {
  const index = segments.findIndex((segment) => segment.threadId === key.threadId);
  if (index === -1) return null;
  const at = { ordinal: key.ordinal, itemId: key.itemId, inclusive: true };
  return [{ ...segments[index]!, from: at }, ...segments.slice(index + 1)];
}

/**
 * Where the row that `entryId` names (an item id, or a message's id as Normal pages take it) sits in
 * `segments`, by index lookups, never a scan; its oldest place when it has several, null when none.
 */
const locateTarget = Effect.fn("ShownHistory.locateTarget")(function* (
  sql: SqlClient.SqlClient,
  segments: ReadonlyArray<ShownSegment>,
  entryId: string,
) {
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly ordinal: number;
    readonly turn_item_id: string;
  }>`
    SELECT thread_id, ordinal, turn_item_id FROM orchestration_v2_projection_turn_items
    WHERE turn_item_id = ${entryId}
    UNION ALL
    SELECT item.thread_id, item.ordinal, item.turn_item_id
    FROM orchestration_v2_projection_messages AS message
    JOIN orchestration_v2_projection_turn_items AS item
      ON item.thread_id = message.thread_id AND item.run_id IS message.run_id
    WHERE message.message_id = ${entryId}
      AND item.type IN ('user_message', 'assistant_message')
      AND json_extract(item.payload_json, '$.messageId') = ${entryId}
  `;
  let target: ShownTarget | null = null;
  for (const row of rows) {
    const key = { ordinal: row.ordinal, itemId: row.turn_item_id };
    const index = segments.findIndex(
      (segment) => segment.threadId === row.thread_id && isBelow(key, segment.from),
    );
    if (index === -1) continue;
    if (
      target === null ||
      index > target.index ||
      (index === target.index && isBelow(key, { ...target, inclusive: false }))
    )
      target = { index, ...key };
  }
  return target;
});

/**
 * Whether `rows`, newest first, hold `minCores` messages, the first message of each reply among
 * them, and the message each answer among them answers: the fold places an answer by that message.
 * An answer whose message is not among the SUB_THREAD_WINDOW_CORES messages before it needs none:
 * send_to_user accepts an answer only to those, so that message never existed.
 */
function shownNeedsMet(rows: ReadonlyArray<ShownRow>, minCores: number): boolean {
  const cores = foldCores(rows.map((row) => row.event).toReversed());
  if (cores.length < minCores) return false;
  const loaded = new Set(cores.map((core) => core.id));
  return cores.every(
    (core, older) =>
      !core.reply ||
      (core.first === null ? older >= SUB_THREAD_WINDOW_CORES : loaded.has(core.first)),
  );
}

const keyOf = (segment: ShownSegment, row: CandidateRow): ShownKey => ({
  threadId: segment.threadId,
  ordinal: row.ordinal,
  itemId: TurnItemId.make(row.turn_item_id),
});

/** The message a rewrite names; undefined for one that rewrites the latest send before it. */
const rewriteTarget = (event: Extract<DisplayEvent, { readonly type: "rewrite" }>) =>
  event.replyTo !== undefined
    ? `reply:${event.replyTo}`
    : event.subThread !== undefined
      ? `first:${event.subThread}`
      : undefined;

/** A candidate whose display event shows nothing, such as a refused send, is null. */
const decodeShownRow = (segment: ShownSegment, row: CandidateRow) =>
  decodeTurnItem(row.payload_json).pipe(
    Effect.map((item): ShownRow | null => {
      const event = displayEventFromTurnItem(item);
      return event === null || event.type === "other"
        ? null
        : { ...keyOf(segment, row), rowid: row.item_rowid, item, event };
    }),
  );

/**
 * Walks `segments` newest first over the shown rows only, in batches, until it has passed `target`
 * and holds the messages `limits` asks for, checked after each batch. A cap ends it at any row.
 * `next` is the newest shown row the walk left out, which the next page starts at.
 */
const walkShownRows = Effect.fn("ShownHistory.walk")(function* (
  sql: SqlClient.SqlClient,
  segments: ReadonlyArray<ShownSegment>,
  limits: ShownLimits,
  rowBytes: (row: ShownRow) => number,
  target: ShownTarget | null,
) {
  const rows: ShownRow[] = [];
  const runs = new Set<string>();
  const rewritten = new Set<string>();
  let bytes = 0;
  let met = false;
  for (const [index, segment] of segments.entries()) {
    let from: ShownBound | null = segment.from;
    while (from !== null) {
      const batch: ReadonlyArray<CandidateRow> = yield* readCandidates(sql, segment, from);
      for (const candidate of batch) {
        const row = yield* decodeShownRow(segment, candidate);
        if (row === null) continue;
        // A newer rewrite of the same message already sets its text.
        const rewrite = row.event.type === "rewrite" ? rewriteTarget(row.event) : undefined;
        if (rewrite !== undefined && rewritten.has(rewrite)) continue;
        if (rewrite !== undefined) rewritten.add(rewrite);
        const cost = rowBytes(row);
        const newRun = row.item.runId !== null && !runs.has(row.item.runId);
        if (
          met ||
          (rows.length > 0 &&
            (rows.length >= limits.maxRows ||
              bytes + cost > limits.maxBytes ||
              (newRun && runs.size >= limits.maxRuns)))
        )
          return { rows, next: keyOf(segment, candidate) } satisfies ShownWalk;
        rows.push(row);
        bytes += cost;
        if (row.item.runId !== null) runs.add(row.item.runId);
      }
      const last = batch.at(-1);
      from =
        last === undefined || batch.length < BATCH_ROWS
          ? null
          : { ordinal: last.ordinal, itemId: last.turn_item_id, inclusive: false };
      const passed =
        target === null ||
        index > target.index ||
        (index === target.index && (from === null || !isBelow(target, from)));
      met ||= passed && shownNeedsMet(rows, limits.minCores);
    }
  }
  return { rows, next: null } satisfies ShownWalk;
});

/** A shown row as a page or a snapshot sends it. */
const shownWireRow = (
  row: ShownRow,
  threadId: ThreadId,
  position: number,
): OrchestrationV2ProjectedTurnItem => ({
  position,
  visibility: row.threadId === threadId ? "local" : "inherited",
  sourceThreadId: row.threadId,
  sourceItemId: row.itemId,
  item: projectTurnItemForWire(row.item),
});

/** The thread's latest shown rows, in the bounded snapshot's byte unit. */
export const selectShownWindow = Effect.fn("ShownHistory.selectWindow")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  forkOf: ForkOf,
) {
  const segments = yield* shownSegments(sql, threadId, forkOf);
  if (segments === null) return { rows: [], next: null } satisfies ShownWalk;
  return yield* walkShownRows(
    sql,
    segments,
    WINDOW_LIMITS,
    (row) => projectedRowBoundedSnapshotEncodedBytes(shownWireRow(row, threadId, 0), threadId),
    null,
  );
});

/** The cursor of a shown window, whose walk bounded its rows already; undefined for any other. */
export function shownWindow(snapshot: {
  readonly snapshotSequence: number;
  readonly shownHistory?: { readonly next: ShownKey | null } | undefined;
}): Pick<SelectTimelinePageResult, "nextCursor" | "hasMoreHistory"> | undefined {
  const next = snapshot.shownHistory?.next;
  return next === undefined
    ? undefined
    : {
        nextCursor: next === null ? null : encodeShownCursor(snapshot.snapshotSequence, next),
        hasMoreHistory: next !== null,
      };
}

/**
 * The shown rows older than a shown cursor, as a history page; null when the thread is missing or
 * deleted. A page with `throughEntryId` reads on until it has passed that row, and is a plain page
 * when the row is not older than the cursor.
 */
export const shownHistoryPage = Effect.fn("ShownHistory.page")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  cursor: ShownKey,
  throughEntryId: string | undefined,
  forkOf: ForkOf,
) {
  const segments = yield* shownSegments(sql, threadId, forkOf);
  if (segments === null) return null;
  const from = segmentsFrom(segments, cursor);
  if (from === null) return yield* new InvalidThreadHistoryCursorError();
  const target =
    throughEntryId === undefined ? null : yield* locateTarget(sql, from, throughEntryId);
  const walk = yield* walkShownRows(
    sql,
    from,
    target === null ? PAGE_LIMITS : TARGETED_PAGE_LIMITS,
    (row) => projectedRowEncodedBytes(shownWireRow(row, threadId, 0)),
    target,
  );
  const [revision] = yield* sql<{ readonly sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
  `;
  const snapshotSequence = revision?.sequence ?? 0;
  return {
    snapshotSequence,
    items: walk.rows.toReversed().map((row, position) => shownWireRow(row, threadId, position)),
    nextCursor: walk.next === null ? null : encodeShownCursor(snapshotSequence, walk.next),
    hasMoreHistory: walk.next !== null,
  } satisfies OrchestrationV2ThreadHistoryPage;
});

/**
 * Replaces ProjectionStore.retainedWindowRows for a shown window. Next to the walked rows it keeps
 * the newest row, active items and failed errors, none older than the oldest walked row so the
 * window stays contiguous; with no such row, all active items and the latest run's errors only.
 */
export function shownRetainedRows(sql: SqlClient.SqlClient, threadId: ThreadId, walk: ShownWalk) {
  const local = walk.rows.filter((row) => row.threadId === threadId);
  const floor =
    local.length === 0 || local.length < walk.rows.length ? null : local.at(-1)!.ordinal;
  return sql`
    WITH retained AS MATERIALIZED (
      SELECT rowid AS item_rowid, ordinal, turn_item_id
      FROM orchestration_v2_projection_turn_items
      WHERE rowid IN (SELECT value FROM json_each(${JSON.stringify(local.map((row) => row.rowid))}))
      UNION
      SELECT item_rowid, ordinal, turn_item_id FROM (
        SELECT rowid AS item_rowid, ordinal, turn_item_id
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}
        ORDER BY ordinal DESC, turn_item_id DESC
        LIMIT 1
      )
      UNION
      SELECT rowid AS item_rowid, ordinal, turn_item_id
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND status IN ('pending', 'running', 'waiting')
        AND ordinal >= ${floor ?? 0}
      UNION
      SELECT rowid AS item_rowid, ordinal, turn_item_id
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND type = 'error' AND status = 'failed'
        AND ${
          floor === null
            ? sql`run_id = (SELECT run_id FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1)`
            : sql`ordinal >= ${floor}`
        }
      ORDER BY ordinal ASC, turn_item_id ASC
    ), deferred_work AS (
      SELECT NULL AS run_id, NULL AS first_ordinal, NULL AS last_ordinal, NULL AS item_count
      WHERE 0
    )
  `;
}

/** Puts the walked rows of fork ancestors before the thread's own visible rows. */
export function withInherited(
  projection: OrchestrationV2ThreadProjection,
  walk: ShownWalk,
): OrchestrationV2ThreadProjection {
  const threadId = projection.thread.id;
  const inherited = walk.rows.filter((row) => row.threadId !== threadId).reverse();
  if (inherited.length === 0) return projection;
  return {
    ...projection,
    visibleTurnItems: [
      ...inherited.map((row) => ({
        position: 0,
        visibility: "inherited" as const,
        sourceThreadId: row.threadId,
        sourceItemId: row.itemId,
        item: row.item,
      })),
      ...projection.visibleTurnItems,
    ].map((row, position) => ({ ...row, position })),
  };
}
