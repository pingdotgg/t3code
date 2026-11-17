import {
  type NodeId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadHistoryTrimReport,
  type ThreadHistoryTrimStatus,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettingsModule from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ThreadHistoryTrimError extends Schema.TaggedError<ThreadHistoryTrimError>()(
  "ThreadHistoryTrimError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ThreadHistoryTrim extends Context.Service<
  ThreadHistoryTrim,
  {
    /** What the next pass would remove under the current setting. Changes nothing. */
    readonly preview: Effect.Effect<ThreadHistoryTrimReport, ThreadHistoryTrimError>;
    /** Queues a pass and returns what it is about to remove. */
    readonly trimNow: Effect.Effect<ThreadHistoryTrimReport, ThreadHistoryTrimError>;
    /** When the last pass finished and when the next one is due. */
    readonly status: Stream.Stream<ThreadHistoryTrimStatus>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadHistoryTrim") {}

const DAY_MS = 24 * 60 * 60 * 1_000;
const PASS_INTERVAL_MS = 30 * DAY_MS;
const LAST_PASS = "thread-history-trim-last-pass";
const DELETE_PAGE_SIZE = 200;
const NOTICE_SIGNAL = "history-trim";
// Work the reader skips: `file_change` stays because it is small and names what a run touched,
// and so does output the timeline always shows inline (`inline_work_output`).
const TRIMMED_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "reasoning",
  "file_search",
  "web_search",
] as const;
const TRIMMED_NODE_KINDS = ["tool_call", "reasoning"] as const;
const LIVE_ITEM_STATUSES = ["pending", "running", "waiting"] as const;
const LIVE_NODE_STATUSES = ["pending", "starting", "running", "waiting"] as const;
const LIVE_RUN_STATUSES = ["queued", "preparing", "starting", "running", "waiting"] as const;

type Candidate = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOrdinal: number;
  readonly updatedAt: string;
};
type Mode = "background" | "manual";

const sumBytes = (rows: ReadonlyArray<{ readonly bytes: number }>) =>
  rows.reduce((total, row) => total + row.bytes, 0);

// Space a row gives back: its payload plus each copy of its ids in the row, its indexes and its position row.
const ITEM_BYTES = `(octet_length(payload_json) + 5 * length(turn_item_id) + 8 * length(thread_id)
  + 3 * COALESCE(length(run_id), 0) + 2 * COALESCE(length(node_id), 0)
  + 2 * COALESCE(length(provider_turn_id), 0) + COALESCE(length(provider_thread_id), 0)
  + COALESCE(length(parent_item_id), 0))`;
const nodeBytes = (alias: string) =>
  `(octet_length(${alias}payload_json) + 2 * length(${alias}node_id) + 3 * length(${alias}thread_id)
  + length(${alias}root_node_id) + 2 * COALESCE(length(${alias}run_id), 0)
  + 2 * COALESCE(length(${alias}parent_node_id), 0) + 2 * COALESCE(length(${alias}provider_turn_id), 0)
  + COALESCE(length(${alias}provider_thread_id), 0))`;

function trimNoticeMessage(afterDays: number): string {
  return `Tool output and reasoning above this point were removed to save space after ${afterDays} ${afterDays === 1 ? "day" : "days"} without use. Messages, plans and file changes are kept.`;
}

/** Ids no kept row points at, children first, so a pass that stops early never orphans a row. */
function unreferenced<Row extends { readonly id: string; readonly parent: string | null }>(
  rows: ReadonlyArray<Row>,
  removable: (row: Row) => boolean,
  referenced: Iterable<string>,
): ReadonlyArray<Row> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const kept = new Set<string>();
  const keep = (id: string | null) => {
    for (let current = id; current !== null && !kept.has(current);) {
      kept.add(current);
      current = byId.get(current)?.parent ?? null;
    }
  };
  for (const id of referenced) keep(id);
  for (const row of rows) if (!removable(row)) keep(row.id);
  const depth = (row: Row) => {
    let count = 0;
    for (let current = row.parent; current !== null; current = byId.get(current)?.parent ?? null)
      count += 1;
    return count;
  };
  return rows
    .filter((row) => !kept.has(row.id))
    .map((row) => ({ row, depth: depth(row) }))
    .toSorted((left, right) => right.depth - left.depth)
    .map(({ row }) => row);
}

/** Drops each id that a row outside `removable` still hangs off, until none does. */
function withoutParentsOfKept(
  removable: ReadonlyArray<string>,
  children: ReadonlyArray<{ readonly id: string; readonly parent: string }>,
  blocked: Iterable<string>,
): ReadonlySet<string> {
  const removed = new Set(removable);
  for (const id of blocked) removed.delete(id);
  for (let changed = true; changed;) {
    changed = false;
    for (const child of children) {
      if (removed.has(child.parent) && !removed.has(child.id)) {
        removed.delete(child.parent);
        changed = true;
      }
    }
  }
  return removed;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;

  // A subagent has no user of its own, so it ages with the thread that started it.
  const readCandidates = (input: {
    readonly idleBefore: string;
    readonly now: string;
    readonly threadId?: ThreadId;
  }) => sql<Candidate>`
    SELECT
      thread.thread_id AS "threadId",
      run.run_id AS "runId",
      run.ordinal AS "runOrdinal",
      thread.updated_at AS "updatedAt"
    FROM orchestration_v2_projection_threads AS thread
    JOIN orchestration_v2_projection_threads AS anchor ON anchor.thread_id = CASE
      WHEN json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        THEN COALESCE(json_extract(thread.payload_json, '$.lineage.rootThreadId'), thread.thread_id)
      ELSE thread.thread_id
    END
    JOIN orchestration_v2_projection_runs AS run ON run.run_id = (
      SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
      WHERE latest.thread_id = thread.thread_id
      ORDER BY latest.ordinal DESC LIMIT 1
    )
    WHERE ${input.threadId === undefined ? sql`1` : sql`thread.thread_id = ${input.threadId}`}
      AND thread.deleted_at IS NULL
      -- Restoring a shared worktree reads a side chat's tool items to learn whether it wrote there.
      AND COALESCE(json_extract(thread.payload_json, '$.lineage.sideChat'), 0) = 0
      AND anchor.created_at < ${input.idleBefore}
      AND COALESCE(json_extract(anchor.payload_json, '$.lastVisitedAt'), '') < ${input.idleBefore}
      AND json_extract(anchor.payload_json, '$.pinnedAt') IS NULL
      AND COALESCE(json_extract(anchor.payload_json, '$.snoozedUntil'), '') <= ${input.now}
      AND NOT EXISTS (
        SELECT 1 FROM json_each(anchor.payload_json, '$.pullRequests') AS link
        WHERE json_extract(link.value, '$.snapshot.state') = 'open'
          AND json_extract(link.value, '$.source') <> 'stack-dismissed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages AS message
        WHERE message.thread_id = anchor.thread_id
          AND message.role = 'user'
          AND message.updated_at >= ${input.idleBefore}
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS recent
        WHERE recent.thread_id IN (thread.thread_id, anchor.thread_id)
          AND (
            recent.status IN ${sql.in(LIVE_RUN_STATUSES)}
            OR recent.requested_at >= ${input.idleBefore}
            OR COALESCE(recent.completed_at, '') >= ${input.idleBefore}
          )
      )
      AND (${input.threadId !== undefined} OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        WHERE item.thread_id = thread.thread_id
          AND item.type IN ${sql.in(TRIMMED_ITEM_TYPES)}
          AND item.inline_work_output = 0
          AND item.status NOT IN ${sql.in(LIVE_ITEM_STATUSES)}
          -- A trimmed thread keeps the tool items its kept items hang off.
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items AS child
            WHERE child.thread_id = item.thread_id AND child.parent_item_id = item.turn_item_id
          )
      ))
    ORDER BY thread.thread_id ASC
  `;

  const window = Effect.gen(function* () {
    const afterDays = (yield* settingsService.getSettings).threadHistoryTrimAfterDays;
    const nowMs = yield* Clock.currentTimeMillis;
    return {
      afterDays,
      now: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      idleBefore: DateTime.formatIso(DateTime.makeUnsafe(nowMs - afterDays * DAY_MS)),
    };
  });

  // Rows other than turn items and nodes that keep a node.
  const nodeReferences = (threadId: ThreadId) => sql`
    SELECT node_id AS id FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT node_id FROM orchestration_v2_projection_plans
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT parent_node_id FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${threadId}
    UNION SELECT node_id FROM orchestration_v2_projection_runtime_requests
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT node_id FROM orchestration_v2_projection_checkpoints
      WHERE thread_id = ${threadId}
    UNION SELECT node_id FROM orchestration_v2_projection_checkpoint_scopes
      WHERE thread_id = ${threadId} AND node_id IS NOT NULL
    UNION SELECT node_id FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ${threadId}
    UNION SELECT root_node_id FROM orchestration_v2_projection_run_attempts
      WHERE thread_id = ${threadId} AND root_node_id IS NOT NULL
    UNION SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
      WHERE thread_id = ${threadId} AND owner_node_id IS NOT NULL
  `;

  // Live forks that show this thread's rows, at any depth; a deleted fork still passes them on.
  const readForks = (threadId: ThreadId) => sql<{ readonly id: ThreadId }>`
    WITH RECURSIVE forks(thread_id, deleted) AS (
      SELECT ${threadId}, 0
      UNION
      SELECT fork.thread_id, fork.deleted_at IS NOT NULL
      FROM orchestration_v2_projection_threads AS fork
      JOIN forks ON json_extract(fork.payload_json, '$.forkedFrom.threadId') = forks.thread_id
      WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
        AND COALESCE(json_extract(fork.payload_json, '$.lineage.sideChat'), 0) = 0
    )
    SELECT thread_id AS id FROM forks WHERE thread_id <> ${threadId} AND deleted = 0
  `;

  const select = Effect.fn("ThreadHistoryTrim.select")(function* (candidate: Candidate) {
    const { threadId } = candidate;
    const items = yield* sql<{
      readonly id: string;
      readonly parent: string | null;
      readonly node: string | null;
      readonly type: string;
      readonly status: string;
      readonly inline: number;
      readonly bytes: number;
    }>`
      SELECT
        turn_item_id AS id,
        parent_item_id AS parent,
        node_id AS node,
        type,
        status,
        inline_work_output AS inline,
        ${sql.literal(ITEM_BYTES)} AS bytes
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId}
    `;
    const trimmedItemTypes: ReadonlyArray<string> = TRIMMED_ITEM_TYPES;
    const liveItemStatuses: ReadonlyArray<string> = LIVE_ITEM_STATUSES;
    const removedItems = unreferenced(
      items,
      (item) =>
        trimmedItemTypes.includes(item.type) &&
        item.inline === 0 &&
        !liveItemStatuses.includes(item.status),
      [],
    );
    const removedItemIds = new Set(removedItems.map((item) => item.id));

    const nodes = yield* sql<{
      readonly id: string;
      readonly parent: string | null;
      readonly kind: string;
      readonly status: string;
      readonly settled: number;
      readonly bytes: number;
    }>`
      SELECT
        node.node_id AS id,
        node.parent_node_id AS parent,
        node.kind,
        node.status,
        COALESCE(run.ordinal <= ${candidate.runOrdinal}, 0) AS settled,
        ${sql.literal(nodeBytes("node."))} AS bytes
      FROM orchestration_v2_projection_nodes AS node
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = node.run_id
      WHERE node.thread_id = ${threadId}
    `;
    const referencedNodes = yield* sql<{ readonly id: string }>`${nodeReferences(threadId)}`;
    const trimmedNodeKinds: ReadonlyArray<string> = TRIMMED_NODE_KINDS;
    const liveNodeStatuses: ReadonlyArray<string> = LIVE_NODE_STATUSES;
    const removedNodes = unreferenced(
      nodes,
      (node) =>
        node.settled === 1 &&
        trimmedNodeKinds.includes(node.kind) &&
        !liveNodeStatuses.includes(node.status),
      [
        ...items.flatMap((item) =>
          item.node === null || removedItemIds.has(item.id) ? [] : [item.node],
        ),
        ...referencedNodes.map((row) => row.id),
      ],
    );
    return { items: removedItems, nodes: removedNodes };
  });

  const estimate = Effect.fn("ThreadHistoryTrim.estimate")(function* (dryRun: boolean) {
    const { afterDays, now, idleBefore } = yield* window;
    const candidates = afterDays <= 0 ? [] : yield* readCandidates({ idleBefore, now });
    let itemCount = 0;
    let estimatedBytes = 0;
    for (const candidate of candidates) {
      const selection = yield* select(candidate);
      itemCount += selection.items.length;
      estimatedBytes += sumBytes(selection.items) + sumBytes(selection.nodes);
      yield* Effect.yieldNow;
    }
    return {
      dryRun,
      afterDays,
      threadCount: candidates.length,
      itemCount,
      estimatedBytes,
    } satisfies ThreadHistoryTrimReport;
  });

  const noticeEvent = Effect.fn("ThreadHistoryTrim.noticeEvent")(function* (
    candidate: Candidate,
    afterDays: number,
  ) {
    const now = yield* DateTime.now;
    return {
      id: yield* ids.allocate.event({ threadId: candidate.threadId }),
      type: "turn-item.updated",
      threadId: candidate.threadId,
      runId: candidate.runId,
      // Every event stamps the thread with its time; reusing the thread's own keeps a trimmed
      // thread where it was in lists sorted by activity.
      occurredAt: DateTime.makeUnsafe(candidate.updatedAt),
      payload: {
        id: ids.derive.runSignalTurnItem({ runId: candidate.runId, signal: NOTICE_SIGNAL }),
        threadId: candidate.threadId,
        runId: candidate.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // EventSink allocates the real position, after the run's existing items.
        ordinal: 0,
        status: "completed",
        title: "Older detail was trimmed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "system_notice",
        message: trimNoticeMessage(afterDays),
      },
    } satisfies OrchestrationV2DomainEvent;
  });

  /** Removes one page in a transaction that first confirms the thread is still idle and trimming on. */
  const trimPage = Effect.fn("ThreadHistoryTrim.trimPage")(function* (
    threadId: ThreadId,
    page: { readonly itemIds: ReadonlyArray<string>; readonly nodeIds: ReadonlyArray<string> },
  ) {
    // Assigned inside the transaction, which narrowing cannot see.
    let outcome = "trimmed" as "trimmed" | "thread-in-use" | "trimming-off";
    let removed: { readonly itemIds: ReadonlySet<string>; readonly nodeIds: ReadonlySet<string> } =
      {
        itemIds: new Set(),
        nodeIds: new Set(),
      };
    yield* eventSink.writeBuilt(
      Effect.gen(function* () {
        const { afterDays, now, idleBefore } = yield* window;
        if (afterDays <= 0) {
          outcome = "trimming-off";
          return [];
        }
        const current = (yield* readCandidates({ idleBefore, now, threadId }))[0];
        if (current === undefined) {
          outcome = "thread-in-use";
          return [];
        }
        const itemIds =
          page.itemIds.length === 0
            ? []
            : yield* sql<{ readonly id: TurnItemId }>`
          SELECT turn_item_id AS id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id IN ${sql.in(page.itemIds)}
            AND status NOT IN ${sql.in(LIVE_ITEM_STATUSES)} AND inline_work_output = 0
        `;
        const itemChildren =
          page.itemIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly parent: string;
              }>`
          SELECT turn_item_id AS id, parent_item_id AS parent
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND parent_item_id IN ${sql.in(page.itemIds)}
        `;
        const items = withoutParentsOfKept(
          itemIds.map((row) => row.id),
          itemChildren,
          [],
        );

        const nodeIds =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{ readonly id: NodeId }>`
          SELECT node_id AS id FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id IN ${sql.in(page.nodeIds)}
            AND status NOT IN ${sql.in(LIVE_NODE_STATUSES)}
        `;
        const nodeChildren =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly parent: string;
              }>`
          SELECT node_id AS id, parent_node_id AS parent FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND parent_node_id IN ${sql.in(page.nodeIds)}
        `;
        const nodeHolders =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly node: string;
              }>`
          SELECT turn_item_id AS id, node_id AS node FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id IN ${sql.in(page.nodeIds)}
        `;
        const otherReferences =
          page.nodeIds.length === 0
            ? []
            : yield* sql<{ readonly id: string }>`
          SELECT id FROM (${nodeReferences(threadId)}) WHERE id IN ${sql.in(page.nodeIds)}
        `;
        const nodes = withoutParentsOfKept(
          nodeIds.map((row) => row.id),
          nodeChildren,
          [
            ...nodeHolders.flatMap((row) => (items.has(row.id) ? [] : [row.node])),
            ...otherReferences.map((row) => row.id),
          ],
        );
        if (items.size === 0 && nodes.size === 0) return [];
        removed = { itemIds: items, nodeIds: nodes };
        const noticeId = ids.derive.runSignalTurnItem({
          runId: current.runId,
          signal: NOTICE_SIGNAL,
        });
        const noticed = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${noticeId}
        `;
        const events: Array<OrchestrationV2DomainEvent> =
          noticed.length === 0 ? [yield* noticeEvent(current, afterDays)] : [];
        const occurredAt = yield* DateTime.now;
        events.push({
          id: yield* ids.allocate.event({ threadId }),
          type: "thread.history-trimmed",
          threadId,
          occurredAt,
          payload: {
            sourceThreadId: threadId,
            turnItemIds: itemIds.flatMap((row) => (items.has(row.id) ? [row.id] : [])),
            nodeIds: nodeIds.flatMap((row) => (nodes.has(row.id) ? [row.id] : [])),
          },
        });
        // Each fork's revision moves with the rows it inherits; its copy stays a few bytes.
        for (const { id: fork } of yield* readForks(threadId)) {
          events.push({
            id: yield* ids.allocate.event({ threadId: fork }),
            type: "thread.history-trimmed",
            threadId: fork,
            occurredAt,
            payload: { sourceThreadId: threadId, turnItemIds: [], nodeIds: [] },
          });
        }
        return events;
      }),
    );
    return { outcome, removed };
  });

  const trimThread = Effect.fn("ThreadHistoryTrim.trimThread")(function* (
    candidate: Candidate,
    rest: Effect.Effect<void>,
  ) {
    const selection = yield* select(candidate).pipe(NodeSqliteClient.readOnlyBackground);
    const rows = [
      ...selection.items.map((row) => ({ ...row, kind: "item" as const })),
      ...selection.nodes.map((row) => ({ ...row, kind: "node" as const })),
    ];
    let itemCount = 0;
    let bytes = 0;
    for (let offset = 0; offset < rows.length; offset += DELETE_PAGE_SIZE) {
      const page = rows.slice(offset, offset + DELETE_PAGE_SIZE);
      const { outcome, removed } = yield* trimPage(candidate.threadId, {
        itemIds: page.flatMap((row) => (row.kind === "item" ? [row.id] : [])),
        nodeIds: page.flatMap((row) => (row.kind === "node" ? [row.id] : [])),
      });
      if (outcome !== "trimmed") return { outcome, itemCount, bytes };
      for (const row of page) {
        if (!(row.kind === "item" ? removed.itemIds : removed.nodeIds).has(row.id)) continue;
        if (row.kind === "item") itemCount += 1;
        bytes += row.bytes;
      }
      // Never hold the writer across a rest: foreground commits run between pages.
      yield* rest;
    }
    return { outcome: "trimmed" as const, itemCount, bytes };
  });

  const readLastPass = sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM orchestration_v2_projection_metadata WHERE projection_name = ${LAST_PASS}
  `.pipe(Effect.map((rows) => rows[0]?.updated_at ?? null));
  const statusOf = (lastTrimmedAt: string | null): ThreadHistoryTrimStatus => ({
    lastTrimmedAt,
    nextTrimAt:
      lastTrimmedAt === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(lastTrimmedAt) + PASS_INTERVAL_MS)),
  });
  const statusRef = yield* SubscriptionRef.make(
    statusOf(yield* readLastPass.pipe(Effect.orElseSucceed(() => null))),
  );
  const recordPass = Effect.gen(function* () {
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (
        ${LAST_PASS}, ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}, 0, ${finishedAt}
      )
      ON CONFLICT(projection_name) DO UPDATE SET updated_at = excluded.updated_at
    `;
    yield* SubscriptionRef.set(statusRef, statusOf(finishedAt));
  });

  const pass = Effect.fn("ThreadHistoryTrim.pass")(function* (mode: Mode) {
    const { afterDays, now, idleBefore } = yield* window;
    if (afterDays <= 0) return;
    if (mode === "background") {
      // Checked here, behind the queue, so a requested trim that just finished counts.
      const last = yield* readLastPass;
      if (last !== null && Date.parse(now) - Date.parse(last) < PASS_INTERVAL_MS) return;
      const report = yield* estimate(true).pipe(NodeSqliteClient.readOnlyBackground);
      if (report.threadCount > 0) {
        yield* Effect.logInfo("Idle thread history due for trimming", report);
      }
    }
    let sliceStarted = yield* Clock.currentTimeMillis;
    // The sweep keeps to a 10% duty so a backlog never competes with a turn; a requested trim does not wait.
    const rest =
      mode === "manual"
        ? Effect.yieldNow
        : Effect.gen(function* () {
            const elapsed = (yield* Clock.currentTimeMillis) - sliceStarted;
            if (elapsed <= 0) return;
            yield* Effect.sleep(elapsed * 9);
            sliceStarted = yield* Clock.currentTimeMillis;
          });
    const candidates = yield* readCandidates({ idleBefore, now }).pipe(
      NodeSqliteClient.readOnlyBackground,
    );
    let threadCount = 0;
    let itemCount = 0;
    let estimatedBytes = 0;
    for (const listed of candidates) {
      // A long pass outlives its list: a thread used since is no longer one.
      const current = yield* readCandidates({ idleBefore, now, threadId: listed.threadId });
      const candidate = current[0];
      if (candidate === undefined) continue;
      const removed = yield* trimThread(candidate, rest).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Trimming a thread's history failed", {
              threadId: candidate.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
        ),
      );
      if (removed === null) continue;
      if (removed.outcome === "trimming-off") return;
      if (removed.itemCount === 0 && removed.bytes === 0) continue;
      threadCount += 1;
      itemCount += removed.itemCount;
      estimatedBytes += removed.bytes;
    }
    if (threadCount > 0) {
      yield* Effect.logInfo("Trimmed idle thread history", {
        mode,
        afterDays,
        threadCount,
        itemCount,
        estimatedBytes,
      });
    }
    yield* recordPass;
  });

  const worker = yield* makeDrainableWorker((mode: Mode) => pass(mode));

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new ThreadHistoryTrimError({ operation, cause })));

  // A pass is due 30 days after the last one finished, or at once when none has. Checking every
  // six hours catches a due date that passes while running; one long timer overflows and drifts
  // across machine sleep.
  yield* forkParked(
    Effect.sleep("5 minutes").pipe(
      Effect.andThen(
        worker
          .enqueue("background")
          .pipe(Effect.andThen(worker.drain), Effect.repeat(Schedule.spaced("6 hours"))),
      ),
    ),
  );

  return ThreadHistoryTrim.of({
    preview: estimate(true).pipe(NodeSqliteClient.readOnlyBackground, mapError("preview")),
    trimNow: estimate(false).pipe(
      NodeSqliteClient.readOnlyBackground,
      Effect.tap(() => worker.enqueue("manual")),
      mapError("trim"),
    ),
    status: SubscriptionRef.changes(statusRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadHistoryTrim, make);
