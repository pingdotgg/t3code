import {
  LOOM_COMMAND_PREVIEW_CHARS,
  LOOM_DEFAULT_WINDOW_MS,
  LOOM_LIMITS,
  LOOM_MAX_WINDOW_MS,
  LoomWindow,
  ProjectLoomError,
  type LoomActivityKind,
  type LoomFilters,
  type LoomRunStatusFilter,
  type LoomWindowInput,
  type OrchestrationV2RunStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { recognizeTestCommand } from "./testCommands.ts";

// Command items examined per page for test recognition; newest first.
const COMMAND_CANDIDATE_LIMIT = 4_000;
const COMMAND_SCAN_CHARS = 600;
// Titles, models, branches and URLs are cut in SQL, so 50 lanes and 50 ancestors always fit the
// byte cap and an oversized value never reaches the server's memory whole.
const LABEL_CHARS = 200;
const URL_CHARS = 1_000;

const ACTIVITY_KINDS = {
  user_message: "user",
  assistant_message: "agent",
  command_execution: "command",
  file_change: "edit",
  dynamic_tool: "tool",
  file_search: "tool",
  web_search: "tool",
  error: "error",
} as const satisfies Record<string, LoomActivityKind>;

const STATUS_BUCKETS: Record<LoomRunStatusFilter, ReadonlyArray<OrchestrationV2RunStatus>> = {
  active: ["preparing", "queued", "starting", "running", "waiting"],
  completed: ["completed"],
  failed: ["failed"],
  interrupted: ["interrupted", "cancelled", "rolled_back"],
};

export class ProjectLoom extends Context.Service<
  ProjectLoom,
  {
    readonly readWindow: (input: LoomWindowInput) => Effect.Effect<LoomWindow, ProjectLoomError>;
  }
>()("t3/project/loom/ProjectLoom") {}

interface ResolvedWindow {
  readonly from: string;
  readonly to: string;
}

const epochMillis = (value: string) =>
  Option.match(DateTime.make(value), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis });
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Defaults to the seven days ending now and never spans more than LOOM_MAX_WINDOW_MS. */
function resolveLoomWindow(
  input: Pick<LoomWindowInput, "from" | "to">,
  nowMs: number,
): ResolvedWindow | null {
  const toMs = input.to === undefined ? nowMs : epochMillis(input.to);
  const requestedFromMs =
    input.from === undefined ? toMs - LOOM_DEFAULT_WINDOW_MS : epochMillis(input.from);
  if (!Number.isFinite(toMs) || !Number.isFinite(requestedFromMs) || requestedFromMs >= toMs) {
    return null;
  }
  const fromMs = Math.max(requestedFromMs, toMs - LOOM_MAX_WINDOW_MS);
  return { from: isoAt(fromMs), to: isoAt(toMs) };
}

function normalizedFilters(filters: LoomFilters | undefined) {
  const sorted = <T extends string>(values: ReadonlyArray<T> | undefined) =>
    values === undefined || values.length === 0 ? undefined : [...new Set(values)].toSorted();
  const title = filters?.title?.trim();
  return {
    title: title === undefined || title.length === 0 ? undefined : title.toLowerCase(),
    statuses: sorted(filters?.statuses),
    providerInstanceIds: sorted(filters?.providerInstanceIds),
    models: sorted(filters?.models),
    branches: sorted(filters?.branches),
  };
}
type NormalizedFilters = ReturnType<typeof normalizedFilters>;
const NO_FILTERS = normalizedFilters(undefined);

// FNV-1a: a cursor only has to notice that its window or filters changed, not resist forgery.
function bindingKey(window: ResolvedWindow, filters: NormalizedFilters): string {
  const text = JSON.stringify([window.from, window.to, filters]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

const LaneCursor = Schema.Struct({ k: Schema.String, c: Schema.String, t: Schema.String });
type LaneCursor = typeof LaneCursor.Type;
const decodeLaneCursor = Schema.decodeUnknownOption(Schema.fromJsonString(LaneCursor));

const encodeCursor = (cursor: LaneCursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor: string) =>
  decodeLaneCursor(Buffer.from(cursor, "base64url").toString("utf8"));

const ids = (values: ReadonlyArray<string>) => JSON.stringify(values);
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

interface LaneRow {
  readonly thread_id: string;
  readonly title: string;
  readonly provider_instance_id: string | null;
  readonly default_provider: string;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly parent_thread_id: string | null;
  readonly relationship: string | null;
  readonly delegated_from_environment_id: string | null;
  readonly delegated_from_thread_id: string | null;
  readonly delegated_from_title: string | null;
  readonly model: string | null;
  readonly branch: string | null;
}

const relationshipOf = (row: LaneRow) =>
  row.relationship === "fork" || row.relationship === "subagent"
    ? row.relationship
    : row.delegated_from_environment_id !== null && row.delegated_from_thread_id !== null
      ? "subagent"
      : "root";

const laneIdentity = (row: LaneRow) => ({
  threadId: row.thread_id,
  title: row.title,
  relationship: relationshipOf(row),
  parentThreadId: row.parent_thread_id,
  ...(row.delegated_from_environment_id === null || row.delegated_from_thread_id === null
    ? {}
    : {
        delegatedFrom: {
          environmentId: row.delegated_from_environment_id,
          threadId: row.delegated_from_thread_id,
          title: row.delegated_from_title ?? "Untitled thread",
        },
      }),
});

const decodeWindow = Schema.decodeUnknownEffect(LoomWindow);
const isProjectLoomError = Schema.is(ProjectLoomError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const laneColumns = sql`
    t.thread_id, substr(trim(t.title), 1, ${LABEL_CHARS}) AS title, t.provider_instance_id,
    t.default_provider, t.created_at, t.archived_at,
    json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
    json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
    json_extract(t.payload_json, '$.delegatedFrom.environmentId') AS delegated_from_environment_id,
    json_extract(t.payload_json, '$.delegatedFrom.threadId') AS delegated_from_thread_id,
    substr(json_extract(t.payload_json, '$.delegatedFrom.title'), 1, ${LABEL_CHARS}) AS delegated_from_title,
    substr(json_extract(t.payload_json, '$.modelSelection.model'), 1, ${LABEL_CHARS}) AS model,
    substr(json_extract(t.payload_json, '$.branch'), 1, ${LABEL_CHARS}) AS branch
  `;

  // Matches the runs recovery index's predicate word for word, which lets SQLite use it.
  const isActiveRun = (alias: string) =>
    sql`${sql.literal(alias)}.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')`;

  const runFilter = (filters: NormalizedFilters, alias: string) => {
    const run = sql.literal(alias);
    const statuses = filters.statuses?.flatMap((bucket) => STATUS_BUCKETS[bucket]);
    return sql`
      ${statuses === undefined ? sql`` : sql`AND ${run}.status IN (SELECT value FROM json_each(${ids(statuses)}))`}
      ${filters.providerInstanceIds === undefined ? sql`` : sql`AND ${run}.provider_instance_id IN (SELECT value FROM json_each(${ids(filters.providerInstanceIds)}))`}
      ${filters.models === undefined ? sql`` : sql`AND json_extract(${run}.payload_json, '$.modelSelection.model') IN (SELECT value FROM json_each(${ids(filters.models)}))`}
    `;
  };

  const hasRunFilter = (filters: NormalizedFilters) =>
    filters.statuses !== undefined ||
    filters.providerInstanceIds !== undefined ||
    filters.models !== undefined;

  // A run overlaps when it was requested inside the window, was requested earlier and completed
  // inside or after it, or was requested earlier and is still active. A finished run whose end
  // was never recorded is placed by its request time alone. Each case is pinned to the index
  // whose range it is, so no read walks a lane's history from before the window.
  const overlappingRuns = (
    threads: Statement.Fragment,
    window: ResolvedWindow,
    filters: NormalizedFilters,
  ) => [
    sql`
      SELECT r.rowid AS id, r.requested_at, r.run_id FROM orchestration_v2_projection_runs r
        INDEXED BY orchestration_v2_projection_runs_thread_requested_idx
      WHERE r.thread_id IN ${threads}
        AND r.requested_at >= ${window.from} AND r.requested_at <= ${window.to}
        ${runFilter(filters, "r")}
    `,
    sql`
      SELECT r.rowid AS id, r.requested_at, r.run_id FROM orchestration_v2_projection_runs r
        INDEXED BY orchestration_v2_projection_runs_thread_completed_idx
      WHERE r.thread_id IN ${threads}
        AND r.completed_at >= ${window.from} AND r.requested_at < ${window.from}
        ${runFilter(filters, "r")}
    `,
    sql`
      SELECT r.rowid AS id, r.requested_at, r.run_id FROM orchestration_v2_projection_runs r
        INDEXED BY orchestration_v2_projection_runs_recovery_idx
      WHERE r.thread_id IN ${threads} AND ${isActiveRun("r")}
        AND r.completed_at IS NULL AND r.requested_at < ${window.from}
        ${runFilter(filters, "r")}
    `,
  ];

  const laneHasRun = (window: ResolvedWindow, filters: NormalizedFilters) =>
    sql.or(
      overlappingRuns(sql`(t.thread_id)`, window, filters).map((select) => sql`EXISTS (${select})`),
    );

  // A lane is any thread with something to draw in the window. Every projected thread event
  // advances updated_at, except pull request links, so candidates are the threads updated since
  // the window opened, threads with a run still active, and threads with links. CROSS JOIN keeps
  // the candidates as the outer loop instead of every thread in the project.
  const readLanes = (
    projectId: ProjectId,
    window: ResolvedWindow,
    filters: NormalizedFilters,
    after: LaneCursor | null,
  ) => sql<LaneRow>`
    WITH candidate(thread_id) AS (
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId} AND updated_at >= ${window.from}
      UNION
      SELECT r.thread_id FROM orchestration_v2_projection_runs r WHERE ${isActiveRun("r")}
      UNION
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE project_id = ${projectId} AND updated_at < ${window.from}
        AND CASE WHEN json_valid(payload_json)
          THEN json_array_length(payload_json, '$.pullRequests') > 0 ELSE 0 END
    )
    SELECT ${laneColumns}
    FROM candidate CROSS JOIN orchestration_v2_projection_threads t
      ON t.thread_id = candidate.thread_id
    WHERE t.project_id = ${projectId}
      AND t.deleted_at IS NULL
      AND t.created_at <= ${window.to}
      AND (
        t.created_at >= ${window.from}
        OR ${laneHasRun(window, NO_FILTERS)}
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_checkpoints c
          WHERE c.thread_id = t.thread_id
            AND c.captured_at >= ${window.from} AND c.captured_at <= ${window.to}
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents s
            INDEXED BY orchestration_v2_projection_subagents_thread_idx
          WHERE s.thread_id = t.thread_id
            AND s.started_at >= ${window.from} AND s.started_at <= ${window.to}
            AND s.child_thread_id IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_context_transfers x
          WHERE (x.source_thread_id = t.thread_id OR x.target_thread_id = t.thread_id)
            AND json_extract(x.payload_json, '$.createdAt') >= ${window.from}
            AND json_extract(x.payload_json, '$.createdAt') <= ${window.to}
        )
        OR EXISTS (
          SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
          WHERE json_extract(link.value, '$.linkedAt') >= ${window.from}
            AND json_extract(link.value, '$.linkedAt') <= ${window.to}
        )
      )
      ${filters.title === undefined ? sql`` : sql`AND instr(lower(t.title), ${filters.title}) > 0`}
      ${filters.branches === undefined ? sql`` : sql`AND json_extract(t.payload_json, '$.branch') IN (SELECT value FROM json_each(${ids(filters.branches)}))`}
      ${hasRunFilter(filters) ? sql`AND ${laneHasRun(window, filters)}` : sql``}
      ${after === null ? sql`` : sql`AND (t.created_at < ${after.c} OR (t.created_at = ${after.c} AND t.thread_id < ${after.t}))`}
    ORDER BY t.created_at DESC, t.thread_id DESC
    LIMIT ${LOOM_LIMITS.lanes + 1}
  `;

  // Walks up lineage for parents not on this page. Deleted or other-project parents stay absent.
  const readAncestors = Effect.fn("ProjectLoom.readAncestors")(function* (
    projectId: ProjectId,
    lanes: ReadonlyArray<LaneRow>,
  ) {
    const known = new Set(lanes.map((lane) => lane.thread_id));
    const ancestors: Array<LaneRow> = [];
    let wanted = lanes.flatMap((lane) => lane.parent_thread_id ?? []);
    let truncated = false;
    while (wanted.length > 0) {
      const next = [...new Set(wanted)].filter((id) => !known.has(id));
      if (next.length === 0) break;
      for (const id of next) known.add(id);
      const rows = yield* sql<LaneRow>`
        SELECT ${laneColumns}
        FROM orchestration_v2_projection_threads t
        WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
          AND t.thread_id IN (SELECT value FROM json_each(${ids(next)}))
        ORDER BY t.created_at DESC, t.thread_id DESC
      `;
      const room = LOOM_LIMITS.ancestors - ancestors.length;
      if (rows.length > room) truncated = true;
      ancestors.push(...rows.slice(0, room));
      if (truncated) break;
      wanted = rows.flatMap((row) => row.parent_thread_id ?? []);
    }
    return { ancestors, truncated };
  });

  const laneSet = (laneIds: ReadonlyArray<string>) =>
    sql`(SELECT value FROM json_each(${ids(laneIds)}))`;

  // Run ids are chosen first, so the sort never carries payload columns.
  const readRuns = (
    laneIds: ReadonlyArray<string>,
    window: ResolvedWindow,
    filters: NormalizedFilters,
  ) => sql<{
    readonly run_id: string;
    readonly thread_id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly provider_instance_id: string | null;
    readonly provider: string;
    readonly model: string | null;
    readonly user_message_id: string;
    readonly requested_at: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
  }>`
    WITH picked AS (
      ${sql.join(" UNION ALL ", false)(overlappingRuns(laneSet(laneIds), window, filters))}
      ORDER BY 2 DESC, 3 DESC
      LIMIT ${LOOM_LIMITS.runs + 1}
    )
    SELECT
      r.run_id, r.thread_id, r.ordinal, r.status, r.provider_instance_id, r.provider,
      substr(json_extract(r.payload_json, '$.modelSelection.model'), 1, ${LABEL_CHARS}) AS model,
      json_extract(r.payload_json, '$.userMessageId') AS user_message_id,
      r.requested_at,
      json_extract(r.payload_json, '$.startedAt') AS started_at,
      r.completed_at
    FROM picked JOIN orchestration_v2_projection_runs r ON r.rowid = picked.id
    ORDER BY picked.requested_at DESC, picked.run_id DESC
  `;

  const readCheckpoints = (laneIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly checkpoint_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly status: string;
    readonly captured_at: string;
    readonly file_count: number;
    readonly additions: number;
    readonly deletions: number;
  }>`
    SELECT
      c.checkpoint_id, c.thread_id, c.run_id, c.status, c.captured_at,
      COALESCE(json_array_length(c.payload_json, '$.files'), 0) AS file_count,
      (SELECT COALESCE(SUM(json_extract(f.value, '$.additions')), 0) FROM json_each(c.payload_json, '$.files') f) AS additions,
      (SELECT COALESCE(SUM(json_extract(f.value, '$.deletions')), 0) FROM json_each(c.payload_json, '$.files') f) AS deletions
    FROM orchestration_v2_projection_checkpoints c
    WHERE c.thread_id IN ${laneSet(laneIds)}
      AND c.captured_at >= ${window.from} AND c.captured_at <= ${window.to}
    ORDER BY c.captured_at DESC, c.checkpoint_id DESC
    LIMIT ${LOOM_LIMITS.markers + 1}
  `;

  // Links live in the thread payload beside their snapshots, stacks and watches; only the
  // marker fields leave SQLite.
  const readPullRequests = (laneIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly thread_id: string;
    readonly host: string | null;
    readonly repository: string;
    readonly number: number;
    readonly url: string;
    readonly source: string;
    readonly linked_at: string;
    readonly title: string | null;
  }>`
    SELECT thread_id, host, repository, number, url, source, linked_at, title
    FROM (
      SELECT
        t.thread_id,
        substr(json_extract(link.value, '$.host'), 1, ${LABEL_CHARS}) AS host,
        substr(json_extract(link.value, '$.repository'), 1, ${LABEL_CHARS}) AS repository,
        json_extract(link.value, '$.number') AS number,
        substr(json_extract(link.value, '$.url'), 1, ${URL_CHARS}) AS url,
        json_extract(link.value, '$.source') AS source,
        json_extract(link.value, '$.linkedAt') AS linked_at,
        substr(json_extract(link.value, '$.snapshot.title'), 1, ${LABEL_CHARS}) AS title
      FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.pullRequests') link
      WHERE t.thread_id IN ${laneSet(laneIds)}
    )
    WHERE linked_at >= ${window.from} AND linked_at <= ${window.to}
      AND repository IS NOT NULL AND number IS NOT NULL AND url IS NOT NULL
    ORDER BY linked_at DESC, thread_id DESC, number DESC
    LIMIT ${LOOM_LIMITS.markers + 1}
  `;

  // The expression index picks commands inside the window before any payloads are read.
  const readCommands = (runIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly turn_item_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly exit_code: number | null;
    readonly input: string | null;
  }>`
    SELECT
      item.turn_item_id, item.thread_id, item.run_id,
      json_extract(item.payload_json, '$.startedAt') AS started_at,
      json_extract(item.payload_json, '$.completedAt') AS completed_at,
      json_extract(item.payload_json, '$.exitCode') AS exit_code,
      substr(json_extract(item.payload_json, '$.input'), 1, ${COMMAND_SCAN_CHARS}) AS input
    FROM (
      SELECT rowid AS id,
        COALESCE(json_extract(payload_json, '$.startedAt'), json_extract(payload_json, '$.completedAt')) AS at
      FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_run_command_at_idx
      WHERE run_id IN (SELECT value FROM json_each(${ids(runIds)}))
        AND type = 'command_execution'
        AND COALESCE(json_extract(payload_json, '$.startedAt'), json_extract(payload_json, '$.completedAt')) >= ${window.from}
        AND COALESCE(json_extract(payload_json, '$.startedAt'), json_extract(payload_json, '$.completedAt')) <= ${window.to}
      ORDER BY at DESC, rowid DESC
      LIMIT ${COMMAND_CANDIDATE_LIMIT + 1}
    ) candidate
    JOIN orchestration_v2_projection_turn_items item ON item.rowid = candidate.id
    ORDER BY candidate.at DESC, candidate.id DESC
  `;

  const readActivity = (runIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly run_id: string;
    readonly thread_id: string;
    readonly type: keyof typeof ACTIVITY_KINDS;
    readonly updated_at: string;
  }>`
    SELECT run_id, thread_id, type, updated_at
    FROM orchestration_v2_projection_turn_items
      INDEXED BY orchestration_v2_projection_turn_items_run_updated_idx
    WHERE run_id IN (SELECT value FROM json_each(${ids(runIds)}))
      AND type IN (SELECT value FROM json_each(${ids(Object.keys(ACTIVITY_KINDS))}))
      AND updated_at >= ${window.from} AND updated_at <= ${window.to}
    ORDER BY updated_at DESC, rowid DESC
    LIMIT ${LOOM_LIMITS.activityTicks + 1}
  `;

  // Named, because SQLite otherwise reads child_thread_id IS NULL through the child thread
  // index, which holds every other project's native tasks too.
  const readTaskMarkers = (laneIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly subagent_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly status: string;
    readonly started_at: string;
    readonly completed_at: string | null;
    readonly title: string | null;
    readonly remote_environment_id: string | null;
    readonly remote_thread_id: string | null;
    readonly remote_label: string | null;
  }>`
    SELECT s.subagent_id, s.thread_id, s.run_id, s.status, s.started_at, s.completed_at,
      substr(json_extract(s.payload_json, '$.title'), 1, ${LABEL_CHARS}) AS title,
      json_extract(s.payload_json, '$.remoteChild.environmentId') AS remote_environment_id,
      json_extract(s.payload_json, '$.remoteChild.threadId') AS remote_thread_id,
      substr(json_extract(s.payload_json, '$.remoteChild.label'), 1, ${LABEL_CHARS}) AS remote_label
    FROM orchestration_v2_projection_subagents s
      INDEXED BY orchestration_v2_projection_subagents_thread_idx
    WHERE s.thread_id IN ${laneSet(laneIds)}
      AND s.started_at >= ${window.from} AND s.started_at <= ${window.to}
      AND s.child_thread_id IS NULL
    ORDER BY s.started_at DESC, s.subagent_id DESC
    LIMIT ${LOOM_LIMITS.markers + 1}
  `;

  const countUntimedTasks = (laneIds: ReadonlyArray<string>, window: ResolvedWindow) => sql<{
    readonly count: number;
  }>`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM orchestration_v2_projection_subagents s
        INDEXED BY orchestration_v2_projection_subagents_thread_idx
      WHERE s.thread_id IN ${laneSet(laneIds)}
        AND s.started_at IS NULL AND s.child_thread_id IS NULL
        AND s.updated_at >= ${window.from} AND s.updated_at <= ${window.to}
      LIMIT ${LOOM_LIMITS.markers + 1}
    )
  `;

  // Both endpoints must belong to the project, so an edge never names another project's thread.
  const readEdges = (
    projectId: ProjectId,
    laneIds: ReadonlyArray<string>,
    window: ResolvedWindow,
  ) => sql<{
    readonly context_transfer_id: string;
    readonly type: string;
    readonly source_thread_id: string;
    readonly target_thread_id: string;
    readonly source_run_id: string | null;
    readonly target_run_id: string | null;
    readonly created_at: string;
    readonly status: string;
  }>`
    SELECT x.context_transfer_id, x.type, x.source_thread_id, x.target_thread_id,
      json_extract(x.payload_json, '$.sourcePoint.runId') AS source_run_id,
      x.target_run_id, x.created_at, x.status
    FROM (
      SELECT ct.*, json_extract(ct.payload_json, '$.createdAt') AS created_at
      FROM orchestration_v2_projection_context_transfers ct
      WHERE ct.source_thread_id IN ${laneSet(laneIds)}
         OR ct.target_thread_id IN ${laneSet(laneIds)}
    ) x
    WHERE x.created_at >= ${window.from} AND x.created_at <= ${window.to}
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads s
        WHERE s.thread_id = x.source_thread_id AND s.project_id = ${projectId} AND s.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads d
        WHERE d.thread_id = x.target_thread_id AND d.project_id = ${projectId} AND d.deleted_at IS NULL)
    ORDER BY x.created_at DESC, x.context_transfer_id DESC
    LIMIT ${LOOM_LIMITS.edges + 1}
  `;

  // One read transaction on the reader connection: a consistent snapshot, off the writer.
  const readRows = (
    projectId: ProjectId,
    window: ResolvedWindow,
    filters: NormalizedFilters,
    after: LaneCursor | null,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const laneRows = yield* readLanes(projectId, window, filters, after);
          const lanes = laneRows.slice(0, LOOM_LIMITS.lanes);
          const laneIds = lanes.map((lane) => lane.thread_id);
          const ancestors = yield* readAncestors(projectId, lanes);
          const runRows = yield* readRuns(laneIds, window, filters);
          const runIds = runRows.slice(0, LOOM_LIMITS.runs).map((run) => run.run_id);
          const [checkpoints, pullRequests, commands, activity, tasks, untimed, edges] =
            yield* Effect.all([
              readCheckpoints(laneIds, window),
              readPullRequests(laneIds, window),
              readCommands(runIds, window),
              readActivity(runIds, window),
              readTaskMarkers(laneIds, window),
              countUntimedTasks(laneIds, window),
              readEdges(projectId, laneIds, window),
            ]);
          return {
            moreLanes: laneRows.length > LOOM_LIMITS.lanes,
            lanes,
            ancestors,
            runRows,
            checkpoints,
            pullRequests,
            commands,
            activity,
            tasks,
            untimedTasks: untimed[0]?.count ?? 0,
            edges,
          };
        }),
      )
      .pipe(NodeSqliteClient.readOnly);

  const readWindow = Effect.fn("ProjectLoom.readWindow")(function* (input: LoomWindowInput) {
    const { projectId } = input;
    const project = yield* projects.get(projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* new ProjectLoomError({ reason: "missing_project", projectId });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const window = resolveLoomWindow(input, nowMs);
    if (window === null)
      return yield* new ProjectLoomError({ reason: "invalid_window", projectId });
    const filters = normalizedFilters(input.filters);
    const key = bindingKey(window, filters);
    let after: LaneCursor | null = null;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      if (Option.isNone(cursor) || cursor.value.k !== key) {
        return yield* new ProjectLoomError({ reason: "invalid_cursor", projectId });
      }
      after = cursor.value;
    }

    const rows = yield* readRows(projectId, window, filters, after);
    const runs = rows.runRows.slice(0, LOOM_LIMITS.runs);
    const inWindow = (at: string) => at >= window.from && at <= window.to;

    const runById = new Map(runs.map((run) => [run.run_id, run]));
    let activityRows = rows.activity.slice(0, LOOM_LIMITS.activityTicks);

    const pullRequestMarkers = rows.pullRequests.slice(0, LOOM_LIMITS.markers).map((link) => {
      const pullRequest = `${link.host ?? ""}/${link.repository}#${link.number}`;
      return {
        kind: "pull_request" as const,
        id: `${link.thread_id}:${pullRequest}`,
        threadId: link.thread_id,
        runId: null,
        at: link.linked_at,
        repository: link.repository,
        number: link.number,
        url: link.url,
        source: link.source,
        title: link.title,
      };
    });
    const commandCandidates = rows.commands.slice(0, COMMAND_CANDIDATE_LIMIT);
    const testMarkers = commandCandidates.flatMap((row) => {
      const at = row.started_at ?? row.completed_at;
      const command = row.input === null ? null : recognizeTestCommand(row.input);
      return at === null || command === null || !inWindow(at)
        ? []
        : [
            {
              kind: "test_command" as const,
              id: row.turn_item_id,
              threadId: row.thread_id,
              runId: row.run_id,
              at,
              completedAt: row.completed_at,
              command: command.slice(0, LOOM_COMMAND_PREVIEW_CHARS),
              exitCode: row.exit_code,
            },
          ];
    });
    const taskMarkers = rows.tasks.slice(0, LOOM_LIMITS.markers).map((task) => ({
      kind: "subagent_task" as const,
      id: task.subagent_id,
      threadId: task.thread_id,
      runId: task.run_id,
      at: task.started_at,
      completedAt: task.completed_at,
      status: task.status,
      title: task.title,
      ...(task.remote_environment_id === null || task.remote_thread_id === null
        ? {}
        : {
            remoteChild: {
              environmentId: task.remote_environment_id,
              threadId: task.remote_thread_id,
              label: task.remote_label ?? task.remote_environment_id.slice(0, LABEL_CHARS),
            },
          }),
    }));
    const checkpointMarkers = rows.checkpoints.slice(0, LOOM_LIMITS.markers).map((checkpoint) => ({
      kind: "checkpoint" as const,
      id: checkpoint.checkpoint_id,
      threadId: checkpoint.thread_id,
      runId: checkpoint.run_id,
      at: checkpoint.captured_at,
      status: checkpoint.status,
      fileCount: checkpoint.file_count,
      additions: checkpoint.additions,
      deletions: checkpoint.deletions,
    }));
    const allMarkers = [
      ...checkpointMarkers,
      ...pullRequestMarkers,
      ...testMarkers,
      ...taskMarkers,
    ].toSorted((left, right) =>
      left.at === right.at ? (left.id < right.id ? 1 : -1) : left.at < right.at ? 1 : -1,
    );
    const markerCandidatesTruncated = [rows.checkpoints, rows.pullRequests, rows.tasks].some(
      (candidates) => candidates.length > LOOM_LIMITS.markers,
    );

    let lanes = rows.lanes;
    let moreLanes = rows.moreLanes;
    let markers = allMarkers.slice(0, LOOM_LIMITS.markers);
    let runEntries = runs.map((run) => ({
      id: run.run_id,
      threadId: run.thread_id,
      ordinal: run.ordinal,
      status: run.status,
      providerInstanceId: run.provider_instance_id ?? run.provider,
      model: run.model ?? "",
      userMessageId: run.user_message_id,
      requestedAt: run.requested_at,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    }));
    let edges = rows.edges.slice(0, LOOM_LIMITS.edges).map((edge) => ({
      id: edge.context_transfer_id,
      type: edge.type,
      sourceThreadId: edge.source_thread_id,
      targetThreadId: edge.target_thread_id,
      sourceRunId: edge.source_run_id,
      targetRunId: edge.target_run_id,
      at: edge.created_at,
      status: edge.status,
    }));
    let bytesTruncated = false;
    const response = () => {
      const remainingRuns = new Set(runEntries.map((run) => run.id));
      const activity = new Map<
        string,
        { runId: string; threadId: string; ticks: Array<[number, LoomActivityKind]> }
      >();
      // Reversing the newest-first read also preserves rowid order for equal timestamps.
      for (const row of activityRows.toReversed()) {
        if (!remainingRuns.has(row.run_id)) continue;
        const run = runById.get(row.run_id)!;
        let entry = activity.get(row.run_id);
        if (entry === undefined) {
          entry = { runId: row.run_id, threadId: row.thread_id, ticks: [] };
          activity.set(row.run_id, entry);
        }
        entry.ticks.push([
          Date.parse(row.updated_at) - Date.parse(run.requested_at),
          ACTIVITY_KINDS[row.type],
        ]);
      }
      const lastLane = lanes.at(-1);
      const nextCursor =
        moreLanes && lastLane !== undefined
          ? encodeCursor({ k: key, c: lastLane.created_at, t: lastLane.thread_id })
          : null;
      return {
        projectId,
        asOf: isoAt(nowMs),
        from: window.from,
        to: window.to,
        lanes: lanes.map((lane) => ({
          ...laneIdentity(lane),
          providerInstanceId: lane.provider_instance_id ?? lane.default_provider,
          model: lane.model ?? "",
          branch: lane.branch,
          createdAt: lane.created_at,
          archivedAt: lane.archived_at,
        })),
        ancestors: rows.ancestors.ancestors.map(laneIdentity),
        runs: runEntries,
        markers,
        edges,
        activity: [...activity.values()],
        truncated: {
          lanes: nextCursor !== null,
          ancestors: rows.ancestors.truncated,
          runs: rows.runRows.length > LOOM_LIMITS.runs,
          markers: allMarkers.length > LOOM_LIMITS.markers || markerCandidatesTruncated,
          edges: rows.edges.length > LOOM_LIMITS.edges,
          activity: rows.activity.length > LOOM_LIMITS.activityTicks,
          bytes: bytesTruncated,
        },
        coverage: {
          untimedTasks: Math.min(rows.untimedTasks, LOOM_LIMITS.markers),
          untimedTasksTruncated: rows.untimedTasks > LOOM_LIMITS.markers,
          commandsScanned: commandCandidates.length,
          commandsTruncated: rows.commands.length > COMMAND_CANDIDATE_LIMIT,
        },
        nextCursor,
      };
    };

    // Oldest activity goes first, then marks, runs and edges. Lanes and ancestors fit by
    // construction; if oversized ids still overflow, later lanes move to the next page.
    let result = response();
    while (byteLength(result) > LOOM_LIMITS.bytes) {
      bytesTruncated = true;
      if (activityRows.length > 0)
        activityRows = activityRows.slice(0, Math.floor(activityRows.length * 0.8));
      else if (markers.length > 0) markers = markers.slice(0, Math.floor(markers.length * 0.8));
      else if (runEntries.length > 0)
        runEntries = runEntries.slice(0, Math.floor(runEntries.length * 0.8));
      else if (edges.length > 0) edges = edges.slice(0, Math.floor(edges.length * 0.8));
      else if (lanes.length > 1) {
        lanes = lanes.slice(0, Math.floor(lanes.length * 0.8));
        moreLanes = true;
      } else break;
      result = response();
    }

    return yield* decodeWindow(result);
  });

  return {
    readWindow: (input: LoomWindowInput) =>
      readWindow(input).pipe(
        Effect.mapError((cause) =>
          isProjectLoomError(cause)
            ? cause
            : new ProjectLoomError({ reason: "storage", projectId: input.projectId, cause }),
        ),
      ),
  };
});

export const layer = Layer.effect(ProjectLoom, make);
