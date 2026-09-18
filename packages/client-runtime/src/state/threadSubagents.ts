/**
 * The subagent roster for one turn, and the compact label the mobile composer
 * pill renders for it.
 *
 * Scoped to a run rather than the whole thread: a thread accumulates every
 * subagent it ever spawned, while the pill and its sheet answer "what is this
 * turn doing right now". Statuses come from the v2 projection directly, so
 * this stays a pure fold over `runs` and `subagents`.
 */
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ShellThreadStatus,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";
import { copySorted } from "@t3tools/shared/Array";

import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type RunId = Projection["runs"][number]["id"];

export interface ThreadTurnSubagents {
  /** The run the roster belongs to: the active one, else the most recent one that spawned agents. */
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  /** Spawn order: startedAt, falling back to updatedAt for agents that never started. */
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
  readonly settledCount: number;
}

export interface SubagentPillSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
}

function orderKey(subagent: Subagent): number {
  return DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);
}

/** null when the thread has never spawned a subagent. */
export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
): ThreadTurnSubagents | null {
  if (projection.subagents.length === 0) return null;
  const activeRun = resolveActiveThreadRun(projection);
  // With no live run the newest roster is still worth showing: a turn that
  // just finished leaves results the user has not read yet.
  const latestUpdated = projection.subagents.reduce((latest, subagent) =>
    DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
      ? subagent
      : latest,
  );
  const runId = activeRun?.id ?? latestUpdated.runId;
  const subagents = copySorted(
    projection.subagents.filter((subagent) => subagent.runId === runId),
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return { runId, turnActive: activeRun !== null, subagents, liveCount, settledCount };
}

/**
 * What the pill's agents segment says, or null while it should stay hidden.
 * The segment is for work in flight: once the turn settles it goes away
 * rather than leaving a stale count above the composer.
 */
export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
): SubagentPillSegment | null {
  if (turn === null) return null;
  if (!turn.turnActive && turn.liveCount === 0) return null;
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: `${turn.liveCount} of ${total} agents working`,
    };
  }
  return {
    label: `${total} done`,
    accessibilityLabel: `${total} ${total === 1 ? "agent" : "agents"} done`,
  };
}

export const THREAD_SUBAGENT_STATUS_LABELS = {
  preparing: "Preparing",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Stopped",
  rolled_back: "Rolled back",
} satisfies Record<OrchestrationV2ShellThreadStatus, string>;

export interface ThreadSubagentTreeRow {
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
  readonly status: keyof typeof THREAD_SUBAGENT_STATUS_LABELS;
  readonly descendants: ThreadSubagentCounts;
}

export interface ThreadSubagentCounts {
  readonly total: number;
  readonly running: number;
  readonly finished: number;
  readonly waiting: number;
  readonly idle: number;
  readonly label: string;
}

function summarizeSubagents(
  running = 0,
  finished = 0,
  waiting = 0,
  idle = 0,
): ThreadSubagentCounts {
  return {
    total: running + finished + waiting + idle,
    running,
    finished,
    waiting,
    idle,
    label: [
      `${running} running`,
      `${finished} finished`,
      ...(waiting > 0 ? [`${waiting} waiting`] : []),
      ...(idle > 0 ? [`${idle} idle`] : []),
    ].join(" · "),
  };
}

/** Walk only subagent descendants; forks remain independent conversations. */
export function deriveThreadSubagentTree(
  parentThreadId: ThreadId,
  childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<EnvironmentThreadShell>>,
) {
  const rows: ThreadSubagentTreeRow[] = [];
  const visited = new Set([parentThreadId]);
  const visit = (id: ThreadId, depth: number): ThreadSubagentCounts => {
    let running = 0;
    let finished = 0;
    let waiting = 0;
    let idle = 0;
    for (const thread of childrenByParent.get(id) ?? []) {
      if (visited.has(thread.id)) continue;
      visited.add(thread.id);
      const shellStatus = thread.source.activityRunStatus ?? thread.source.status;
      const status = shellStatus === "idle" ? (thread.latestRun?.status ?? "idle") : shellStatus;
      const row = {
        thread,
        depth,
        status,
        descendants: summarizeSubagents(),
      } satisfies ThreadSubagentTreeRow;
      rows.push(row);
      row.descendants = visit(thread.id, depth + 1);
      running += row.descendants.running;
      finished += row.descendants.finished;
      waiting += row.descendants.waiting;
      idle += row.descendants.idle;
      switch (status) {
        case "preparing":
        case "queued":
        case "starting":
        case "running":
          running += 1;
          break;
        case "waiting":
          waiting += 1;
          break;
        case "idle":
          idle += 1;
          break;
        default:
          finished += 1;
      }
    }
    return summarizeSubagents(running, finished, waiting, idle);
  };
  const counts = visit(parentThreadId, 0);
  return { rows, ...counts };
}

/** Hide descendants of closed branches without changing their status counts. */
export function visibleThreadSubagentRows(
  rows: ReadonlyArray<ThreadSubagentTreeRow>,
  expandedThreadIds: ReadonlySet<ThreadId>,
) {
  let collapsedDepth = Infinity;
  return rows.filter((row) => {
    if (row.depth > collapsedDepth) return false;
    collapsedDepth = expandedThreadIds.has(row.thread.id) ? Infinity : row.depth;
    return true;
  });
}
