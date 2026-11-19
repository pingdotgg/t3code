import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  OrbitSubtask,
  OrbitSubtaskStatus,
  OrbitTaskAgent,
  OrbitTaskAttention,
  OrbitTaskDetail,
  OrbitTaskInsights,
  OrbitTaskInsightsBreakdownRow,
  OrbitTaskInsightsSummary,
  OrbitTaskMetrics,
  OrbitTasksPage,
  OrbitTaskSummary,
} from "./tasks.ts";

// The snake_case wire shapes of `GET /conn/tasks` and `GET /conn/tasks/{task}`, decoded here
// and only here, then mapped to the camelCase domain types in `tasks.ts`.

const Attention = Schema.NullOr(
  Schema.Struct({
    kind: Schema.Literals(["question", "failure", "direction", "observation", "removal_failure"]),
    question: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
  }),
);

// Subtask and agent literals decode as strings and narrow below, so a value Orbit adds later
// degrades that one item to "unknown" instead of failing the whole task.
const SUBTASK_STATUSES = [
  "todo",
  "reserved",
  "running",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<OrbitSubtaskStatus>;
const AGENT_ROLES = ["implementer", "reviewer"] as const;
const AGENT_STATES = ["idle", "working", "asking_for_input", "done", "failed"] as const;

function known<const T extends string>(values: ReadonlyArray<T>, value: string): T | "unknown" {
  return values.find((entry) => entry === value) ?? "unknown";
}

const Metrics = Schema.Struct({
  duration_ms: Schema.NullOr(Schema.Number),
  tokens: Schema.NullOr(Schema.Number),
  lines_added: Schema.NullOr(Schema.Number),
  lines_deleted: Schema.NullOr(Schema.Number),
});

const ListRow = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  status: Schema.Literals([
    "backlog",
    "todo",
    "reserved",
    "running",
    "reviewing",
    "settling",
    "waiting_for_review",
    "completed",
    "failed",
    "cancelled",
  ]),
  attention: Attention,
  project: Schema.Struct({
    id: Schema.Int,
    slug: Schema.String,
    name: Schema.String,
    code: Schema.NullOr(Schema.String),
  }),
  workspace: Schema.NullOr(
    Schema.Struct({
      instance_id: Schema.Int,
      name: Schema.String,
      status: Schema.String,
      power_state: Schema.NullOr(Schema.Literals(["running", "stopped"])),
      node: Schema.NullOr(Schema.Struct({ id: Schema.Int, name: Schema.String })),
      branch: Schema.NullOr(Schema.String),
      conn_environment_id: Schema.NullOr(EnvironmentId),
    }),
  ),
  pull_request: Schema.NullOr(
    Schema.Struct({
      number: Schema.Int,
      url: Schema.String,
      state: Schema.NullOr(Schema.Literals(["open", "merged", "closed"])),
    }),
  ),
  subtask_counts: Schema.Struct({
    total: Schema.Int,
    todo: Schema.Int,
    running: Schema.Int,
    completed: Schema.Int,
    failed: Schema.Int,
    cancelled: Schema.Int,
  }),
  created_at: Schema.String,
  updated_at: Schema.String,
  last_activity_at: Schema.NullOr(Schema.String),
});

const Subtask = Schema.Struct({
  id: Schema.Int,
  position: Schema.Int,
  title: Schema.String,
  brief: Schema.String,
  deliverables: Schema.Array(
    Schema.Struct({ id: Schema.String, type: Schema.String, description: Schema.String }),
  ),
  status: Schema.String,
  attention: Schema.Unknown,
  current_implementer_agent_id: Schema.NullOr(Schema.Int),
  metrics: Metrics,
});

const Agent = Schema.Struct({
  id: Schema.Int,
  role: Schema.String,
  subtask_ids: Schema.Array(Schema.Int),
  current: Schema.Boolean,
  attempt: Schema.Int,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  needs_input: Schema.Boolean,
  created_at: Schema.String,
  observed_at: Schema.NullOr(Schema.String),
  conn: Schema.NullOr(Schema.Struct({ environment_id: EnvironmentId, thread_id: ThreadId })),
});

const Detail = Schema.Struct({
  ...ListRow.fields,
  brief: Schema.String,
  execution: Schema.Struct({ implementer_mode: Schema.Literals(["per_subtask", "shared"]) }),
  metrics: Metrics,
  subtasks: Schema.Array(Subtask),
  agents: Schema.Array(Agent),
});

// Rows decode one by one, so one row off the contract hides that task, not the page.
const ListEnvelope = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  meta: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
});

const DetailEnvelope = Schema.Struct({ data: Detail });

/** The Gateway's error envelope, loosely: only the code and message matter here. */
export const decodeOrbitTasksErrorEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);

const attention = (value: typeof Attention.Type): OrbitTaskAttention | null => value;
const decodeAttention = Schema.decodeUnknownOption(Attention);

const metrics = (value: typeof Metrics.Type): OrbitTaskMetrics => ({
  durationMs: value.duration_ms,
  tokens: value.tokens,
  linesAdded: value.lines_added,
  linesDeleted: value.lines_deleted,
});

const summary = (row: typeof ListRow.Type): OrbitTaskSummary => ({
  id: row.id,
  title: row.title,
  status: row.status,
  attention: attention(row.attention),
  project: row.project,
  workspace:
    row.workspace === null
      ? null
      : {
          instanceId: row.workspace.instance_id,
          name: row.workspace.name,
          status: row.workspace.status,
          powerState: row.workspace.power_state,
          node: row.workspace.node,
          branch: row.workspace.branch,
          connEnvironmentId: row.workspace.conn_environment_id,
        },
  pullRequest: row.pull_request,
  subtaskCounts: row.subtask_counts,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastActivityAt: row.last_activity_at,
});

const subtask = (value: typeof Subtask.Type): OrbitSubtask => ({
  id: value.id,
  position: value.position,
  title: value.title,
  brief: value.brief,
  deliverables: value.deliverables,
  status: Option.isNone(decodeAttention(value.attention))
    ? "unknown"
    : known(SUBTASK_STATUSES, value.status),
  // Unknown attention leaves the brief readable, with an unknown subtask state.
  attention: Option.getOrNull(decodeAttention(value.attention)),
  currentImplementerAgentId: value.current_implementer_agent_id,
  // Orbit records no per-subtask line delta; never derive one from the task's branch snapshot.
  metrics: { ...metrics(value.metrics), linesAdded: null, linesDeleted: null },
});

const agent = (value: typeof Agent.Type): OrbitTaskAgent => ({
  id: value.id,
  role: known(AGENT_ROLES, value.role),
  subtaskIds: value.subtask_ids,
  current: value.current,
  attempt: value.attempt,
  provider: value.provider,
  model: value.model,
  effort: value.effort,
  state: value.state === null ? null : known(AGENT_STATES, value.state),
  needsInput: value.needs_input,
  createdAt: value.created_at,
  observedAt: value.observed_at,
  conversation:
    value.conn === null
      ? null
      : { environmentId: value.conn.environment_id, threadId: value.conn.thread_id },
});

const decodeList = Schema.decodeUnknownOption(ListEnvelope);
const decodeListRow = Schema.decodeUnknownOption(ListRow);
const decodeDetail = Schema.decodeUnknownOption(DetailEnvelope);

export function decodeOrbitTasksPage(json: unknown): OrbitTasksPage | null {
  return Option.match(decodeList(json), {
    onNone: () => null,
    onSome: (envelope) => {
      const rows = envelope.data.flatMap((row) =>
        Option.match(decodeListRow(row), { onNone: () => [], onSome: (value) => [value] }),
      );
      return {
        tasks: rows.map(summary),
        skipped: envelope.data.length - rows.length,
        nextCursor: envelope.meta?.next_cursor ?? null,
      };
    },
  });
}

export function decodeOrbitTaskDetail(json: unknown): OrbitTaskDetail | null {
  return Option.match(decodeDetail(json), {
    onNone: () => null,
    onSome: ({ data }) => ({
      ...summary(data),
      brief: data.brief,
      implementerMode: data.execution.implementer_mode,
      metrics: metrics(data.metrics),
      subtasks: [...data.subtasks].sort((a, b) => a.position - b.position).map(subtask),
      agents: data.agents.map(agent),
    }),
  });
}

// `GET /api/v1/task-insights`. Every number decodes on its own, so a field Orbit leaves out or
// changes shows a dash for that number only.
const AnyValue = Schema.optionalKey(Schema.Unknown);
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const InsightsSummary = Schema.Struct({
  tasks: AnyValue,
  merged: AnyValue,
  tokens: AnyValue,
  tokens_per_merged_pr: AnyValue,
  lead_time_ms: AnyValue,
  // Orbit 6041 (deploys per task) and 6042 (PR opened); proposed names until those land.
  delivery_time_ms: AnyValue,
  deploy_wait_ms: AnyValue,
  pr_merge_wait_ms: AnyValue,
  pr_first_pass: AnyValue,
  wasted_share: AnyValue,
  review_rounds: AnyValue,
});

const InsightsEnvelope = Schema.Struct({
  data: Schema.Struct({
    period: Schema.Literals(["7d", "30d"]),
    current: InsightsSummary,
    previous: InsightsSummary,
    weekly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    daily: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    breakdowns: Schema.optionalKey(
      Schema.Struct({ model: Schema.optionalKey(Schema.Array(Schema.Unknown)) }),
    ),
  }),
});
const InsightsWeek = Schema.Struct({ week_start: Schema.String, tokens_per_merged_pr: AnyValue });
const InsightsDay = Schema.Struct({ date: Schema.String, merged: Schema.Number });
const InsightsBreakdownRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  tasks: AnyValue,
  merged: AnyValue,
  tokens_per_merged_pr: AnyValue,
  lead_time_ms: AnyValue,
});

const decodeInsights = Schema.decodeUnknownOption(InsightsEnvelope);
const decodeInsightsWeek = Schema.decodeUnknownOption(InsightsWeek);
const decodeInsightsDay = Schema.decodeUnknownOption(InsightsDay);
const decodeInsightsBreakdownRow = Schema.decodeUnknownOption(InsightsBreakdownRow);

const insightsSummary = (value: typeof InsightsSummary.Type): OrbitTaskInsightsSummary => ({
  tasks: numberOrNull(value.tasks),
  merged: numberOrNull(value.merged),
  tokens: numberOrNull(value.tokens),
  tokensPerMergedPr: numberOrNull(value.tokens_per_merged_pr),
  leadTimeMs: numberOrNull(value.lead_time_ms),
  deliveryTimeMs: numberOrNull(value.delivery_time_ms),
  deployWaitMs: numberOrNull(value.deploy_wait_ms),
  prMergeWaitMs: numberOrNull(value.pr_merge_wait_ms),
  prFirstPass: numberOrNull(value.pr_first_pass),
  wastedShare: numberOrNull(value.wasted_share),
  reviewRounds: numberOrNull(value.review_rounds),
});

/** Rows decode one by one: a row off the contract is left out, not the whole answer. */
function eachRow<A, B>(
  rows: ReadonlyArray<unknown> | undefined,
  decode: (row: unknown) => Option.Option<A>,
  map: (value: A) => B,
): ReadonlyArray<B> {
  return (rows ?? []).flatMap((row) =>
    Option.match(decode(row), { onNone: () => [], onSome: (value) => [map(value)] }),
  );
}

export function decodeOrbitTaskInsights(json: unknown): OrbitTaskInsights | null {
  return Option.match(decodeInsights(json), {
    onNone: () => null,
    onSome: ({ data }) => ({
      period: data.period,
      current: insightsSummary(data.current),
      previous: insightsSummary(data.previous),
      weekly: eachRow(data.weekly, decodeInsightsWeek, (week) => ({
        weekStart: week.week_start,
        tokensPerMergedPr: numberOrNull(week.tokens_per_merged_pr),
      })),
      daily: eachRow(data.daily, decodeInsightsDay, (day) => ({
        date: day.date,
        merged: day.merged,
      })),
      byModel: eachRow(
        data.breakdowns?.model,
        decodeInsightsBreakdownRow,
        (row): OrbitTaskInsightsBreakdownRow => ({
          key: row.key,
          label: row.label,
          tasks: numberOrNull(row.tasks),
          merged: numberOrNull(row.merged),
          tokensPerMergedPr: numberOrNull(row.tokens_per_merged_pr),
          leadTimeMs: numberOrNull(row.lead_time_ms),
        }),
      ),
    }),
  });
}
