/**
 * Groups the flat `task.*` orchestration activities a Claude turn emits into one
 * run per `taskId`, and swaps the consumed work-log rows out of the timeline.
 *
 * Fork-owned decision layer for the agent-run cards: pure, no React and no web
 * imports beyond types, so it can move to `packages/client-runtime` when mobile
 * grows the same surface.
 *
 * Keyed by `taskId`, never by `tool_use_id`: activities arrive ordered and
 * persisted, so a progress frame can never beat its own tool row and no orphan
 * buffering is needed. `toolUseId` is an optional link, never the identity.
 */

import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "./session-logic.ts";

export type AgentRunPhase = "running" | "done" | "failed" | "stopped";

export interface AgentRunFeedLine {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly toolName?: string;
}

export interface AgentRun {
  readonly taskId: string;
  /** First consumed activity id — the timeline row identity, stable across re-derivations. */
  readonly rowId: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly turnId: TurnId | null;
  readonly title: string;
  readonly phase: AgentRunPhase;
  readonly taskType?: string;
  readonly subagentType?: string;
  readonly workflowName?: string;
  readonly prompt?: string;
  readonly toolUseId?: string;
  readonly lastToolName?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly ambient: boolean;
  /** True when no `task.started` was in the loaded window — the card says so rather than faking a start. */
  readonly detailsUnavailable: boolean;
  readonly feed: ReadonlyArray<AgentRunFeedLine>;
}

/** Ported from 2code's NESTED_CAP: an uncapped feed is an unbounded row. */
export const AGENT_RUN_FEED_CAP = 20;

const TASK_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.completed",
]);

export function isTerminalAgentRunPhase(phase: AgentRunPhase): boolean {
  return phase !== "running";
}

interface AgentRunDraft {
  taskId: string;
  rowId: string;
  createdAt: string;
  settledAt: string | null;
  turnId: TurnId | null;
  phase: AgentRunPhase;
  sawStart: boolean;
  description?: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  prompt?: string;
  toolUseId?: string;
  lastToolName?: string;
  summary?: string;
  error?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  ambient: boolean;
  feed: AgentRunFeedLine[];
}

export interface AgentRunsResult {
  readonly runs: ReadonlyArray<AgentRun>;
  readonly consumedActivityIds: ReadonlySet<string>;
}

export function deriveAgentRuns(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { readonly activeTurnId: TurnId | null },
): AgentRunsResult {
  const drafts = new Map<string, AgentRunDraft>();
  const consumedActivityIds = new Set<string>();

  // Server-ordered, replayed activities: a single forward pass is enough, and
  // the terminal-phase guard below is only safe because of that ordering.
  for (const activity of activities) {
    if (!TASK_ACTIVITY_KINDS.has(activity.kind)) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = readString(payload, "taskId");
    if (!taskId) {
      continue;
    }
    consumedActivityIds.add(activity.id);

    const draft =
      drafts.get(taskId) ??
      (() => {
        const created: AgentRunDraft = {
          taskId,
          rowId: activity.id,
          createdAt: activity.createdAt,
          settledAt: null,
          turnId: activity.turnId,
          phase: "running",
          sawStart: false,
          ambient: false,
          feed: [],
        };
        drafts.set(taskId, created);
        return created;
      })();

    applyActivity(draft, activity, payload);
  }

  const runs: AgentRun[] = [];
  for (const draft of drafts.values()) {
    runs.push(finalizeDraft(draft, options.activeTurnId));
  }
  return { runs, consumedActivityIds };
}

/**
 * Reuses the previous `AgentRun` objects (and the previous array) whenever a
 * re-derivation produced the same content.
 *
 * The fold re-runs on every thread activity, including the many that have
 * nothing to do with tasks. Without this, each unrelated tool row would hand
 * every consumer a brand new run object: the timeline's row-identity check
 * (`a.run === b.run`) would fail and the header controls hosting the tracker
 * would re-render on a hot path.
 */
export function stabilizeAgentRuns(
  previous: AgentRunsResult | null,
  next: AgentRunsResult,
): AgentRunsResult {
  if (previous === null) {
    return next;
  }
  let changed =
    previous.runs.length !== next.runs.length ||
    previous.consumedActivityIds.size !== next.consumedActivityIds.size;

  const previousByTaskId = new Map(previous.runs.map((run) => [run.taskId, run]));
  const runs = next.runs.map((run, index) => {
    const prior = previousByTaskId.get(run.taskId);
    if (prior !== undefined && agentRunEquals(prior, run)) {
      if (previous.runs[index] !== prior) {
        changed = true; // same runs, different order
      }
      return prior;
    }
    changed = true;
    return run;
  });

  return changed ? { runs, consumedActivityIds: next.consumedActivityIds } : previous;
}

export function agentRunEquals(a: AgentRun, b: AgentRun): boolean {
  return (
    a.taskId === b.taskId &&
    a.rowId === b.rowId &&
    a.createdAt === b.createdAt &&
    a.settledAt === b.settledAt &&
    a.turnId === b.turnId &&
    a.title === b.title &&
    a.phase === b.phase &&
    a.taskType === b.taskType &&
    a.subagentType === b.subagentType &&
    a.workflowName === b.workflowName &&
    a.prompt === b.prompt &&
    a.toolUseId === b.toolUseId &&
    a.lastToolName === b.lastToolName &&
    a.summary === b.summary &&
    a.error === b.error &&
    a.totalTokens === b.totalTokens &&
    a.toolUses === b.toolUses &&
    a.durationMs === b.durationMs &&
    a.ambient === b.ambient &&
    a.detailsUnavailable === b.detailsUnavailable &&
    feedEquals(a.feed, b.feed)
  );
}

/** Feed lines are keyed by their activity id and never rewritten in place. */
function feedEquals(
  a: ReadonlyArray<AgentRunFeedLine>,
  b: ReadonlyArray<AgentRunFeedLine>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]?.id !== b[index]?.id) {
      return false;
    }
  }
  return true;
}

/**
 * The one upstream hook: replaces the work rows an agent run consumed with a
 * single `agent-run` row anchored at the position of the first of them.
 */
export function withAgentRunEntries(
  entries: ReadonlyArray<TimelineEntry>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options: { readonly activeTurnId: TurnId | null },
  /**
   * Pre-derived result, so a caller that also renders the tracker pill folds the
   * activities once instead of twice. Omit it and the fold runs here.
   */
  derived?: AgentRunsResult,
): TimelineEntry[] {
  const { runs, consumedActivityIds } = derived ?? deriveAgentRuns(activities, options);
  if (runs.length === 0) {
    return [...entries];
  }

  // Ambient/housekeeping runs are hidden from the transcript per the SDK's own
  // instruction — their work rows are still consumed so they leave nothing behind.
  const runRows: TimelineEntry[] = runs
    .filter((run) => !run.ambient)
    .map((run) => ({
      id: `agent-run:${run.rowId}`,
      kind: "agent-run" as const,
      createdAt: run.createdAt,
      run,
    }))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Both sides are already ordered by createdAt, so one merge pass keeps the
  // run row at the timeline position of the work it replaced.
  const result: TimelineEntry[] = [];
  let runCursor = 0;
  for (const entry of entries) {
    while (
      runCursor < runRows.length &&
      (runRows[runCursor] as TimelineEntry).createdAt.localeCompare(entry.createdAt) <= 0
    ) {
      result.push(runRows[runCursor] as TimelineEntry);
      runCursor += 1;
    }
    if (entry.kind === "work" && consumedActivityIds.has(entry.entry.id)) {
      continue;
    }
    result.push(entry);
  }
  for (; runCursor < runRows.length; runCursor += 1) {
    result.push(runRows[runCursor] as TimelineEntry);
  }

  return result;
}

function applyActivity(
  draft: AgentRunDraft,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): void {
  if (activity.turnId !== null) {
    draft.turnId = activity.turnId;
  }

  switch (activity.kind) {
    case "task.started": {
      draft.sawStart = true;
      draft.createdAt = activity.createdAt;
      assignString(draft, "description", payload, "detail");
      assignString(draft, "taskType", payload, "taskType");
      assignString(draft, "subagentType", payload, "subagentType");
      assignString(draft, "workflowName", payload, "workflowName");
      assignString(draft, "prompt", payload, "prompt");
      assignString(draft, "toolUseId", payload, "toolUseId");
      if (readBoolean(payload, "ambient")) {
        draft.ambient = true;
      }
      return;
    }

    case "task.progress": {
      // Terminal phase is sticky: a late progress frame must not un-settle a
      // run that already reported an outcome.
      assignString(draft, "subagentType", payload, "subagentType");
      assignString(draft, "toolUseId", payload, "toolUseId");
      assignString(draft, "lastToolName", payload, "lastToolName");
      assignNumber(draft, "totalTokens", payload, "totalTokens");
      assignNumber(draft, "toolUses", payload, "toolUses");
      assignNumber(draft, "durationMs", payload, "durationMs");
      if (!draft.description) {
        const description = readString(payload, "title") ?? readString(payload, "detail");
        if (description !== null) {
          draft.description = description;
        }
      }
      const toolName = readString(payload, "lastToolName");
      pushFeedLine(draft, {
        id: activity.id,
        createdAt: activity.createdAt,
        label:
          readString(payload, "summary") ??
          readString(payload, "title") ??
          readString(payload, "detail") ??
          activity.summary,
        ...(toolName !== null ? { toolName } : {}),
      });
      return;
    }

    case "task.completed": {
      assignNumber(draft, "totalTokens", payload, "totalTokens");
      assignNumber(draft, "toolUses", payload, "toolUses");
      assignNumber(draft, "durationMs", payload, "durationMs");
      assignString(draft, "summary", payload, "summary");
      assignString(draft, "error", payload, "error");
      if (isTerminalAgentRunPhase(draft.phase)) {
        return;
      }
      draft.phase = phaseFromCompletedStatus(readString(payload, "status"));
      draft.settledAt = activity.createdAt;
      return;
    }

    default:
      return;
  }
}

function finalizeDraft(draft: AgentRunDraft, activeTurnId: TurnId | null): AgentRun {
  // A run left non-terminal by a turn that is no longer live can never settle:
  // report it as stopped instead of spinning forever.
  const phase: AgentRunPhase =
    draft.phase === "running" && draft.turnId !== null && draft.turnId !== activeTurnId
      ? "stopped"
      : draft.phase;

  const durationMs =
    draft.durationMs ?? (draft.settledAt ? elapsedMs(draft.createdAt, draft.settledAt) : undefined);

  return {
    taskId: draft.taskId,
    rowId: draft.rowId,
    createdAt: draft.createdAt,
    settledAt: draft.settledAt,
    turnId: draft.turnId,
    title: deriveTitle(draft, phase),
    phase,
    ...(draft.taskType ? { taskType: draft.taskType } : {}),
    ...(draft.subagentType ? { subagentType: draft.subagentType } : {}),
    ...(draft.workflowName ? { workflowName: draft.workflowName } : {}),
    ...(draft.prompt ? { prompt: draft.prompt } : {}),
    ...(draft.toolUseId ? { toolUseId: draft.toolUseId } : {}),
    ...(draft.lastToolName ? { lastToolName: draft.lastToolName } : {}),
    ...(draft.summary ? { summary: draft.summary } : {}),
    ...(draft.error ? { error: draft.error } : {}),
    ...(draft.totalTokens !== undefined ? { totalTokens: draft.totalTokens } : {}),
    ...(draft.toolUses !== undefined ? { toolUses: draft.toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ambient: draft.ambient,
    detailsUnavailable: !draft.sawStart,
    feed: draft.feed,
  };
}

/** One state-picked subject line — never a concatenation, so the row cannot wrap. */
function deriveTitle(draft: AgentRunDraft, phase: AgentRunPhase): string {
  if (draft.workflowName) {
    return draft.workflowName;
  }
  if (draft.subagentType) {
    return draft.subagentType;
  }
  if (phase === "running") {
    return draft.lastToolName ?? draft.description ?? "Agent run";
  }
  return draft.summary ?? draft.description ?? "Agent run";
}

/**
 * Unknown status is a failure, never a green check — re-asserted here because a
 * run restored from persisted activities may predate the server-side normalizer.
 */
function phaseFromCompletedStatus(status: string | null): AgentRunPhase {
  switch (status) {
    case "completed":
      return "done";
    case "stopped":
      return "stopped";
    default:
      return "failed";
  }
}

function pushFeedLine(draft: AgentRunDraft, line: AgentRunFeedLine): void {
  if (line.label.trim().length === 0) {
    return;
  }
  draft.feed.push(line);
  if (draft.feed.length > AGENT_RUN_FEED_CAP) {
    draft.feed.splice(0, draft.feed.length - AGENT_RUN_FEED_CAP);
  }
}

function elapsedMs(from: string, to: string): number | undefined {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readBoolean(payload: Record<string, unknown> | null, key: string): boolean {
  return payload?.[key] === true;
}

type AgentRunDraftStringField =
  | "description"
  | "taskType"
  | "subagentType"
  | "workflowName"
  | "prompt"
  | "toolUseId"
  | "lastToolName"
  | "summary"
  | "error";

function assignString(
  draft: AgentRunDraft,
  field: AgentRunDraftStringField,
  payload: Record<string, unknown> | null,
  key: string,
): void {
  const value = readString(payload, key);
  if (value !== null) {
    draft[field] = value;
  }
}

function assignNumber(
  draft: AgentRunDraft,
  field: "totalTokens" | "toolUses" | "durationMs",
  payload: Record<string, unknown> | null,
  key: string,
): void {
  const value = payload?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    draft[field] = value;
  }
}
