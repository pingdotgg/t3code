import type { OrchestrationSession, OrchestrationThreadActivity } from "@t3tools/contracts";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTask {
  readonly taskId: string;
  /** Human label: the task's description, falling back to its type. */
  readonly name: string;
  readonly startedAt: string;
  readonly status: BackgroundTaskStatus;
  /** Latest task.progress line, for "what is it doing right now" rows. */
  readonly latestProgress: string | null;
  readonly latestProgressAt: string | null;
  readonly settledAt: string | null;
}

export interface BackgroundTaskState {
  readonly running: ReadonlyArray<BackgroundTask>;
  /** Settled (completed/failed/stopped) tasks, most recently settled first. */
  readonly settled: ReadonlyArray<BackgroundTask>;
  /** Oldest running task's start, for an aggregate elapsed label. */
  readonly startedAt: string | null;
}

const EMPTY_STATE: BackgroundTaskState = { running: [], settled: [], startedAt: null };

const FALLBACK_TASK_NAME = "Subagent";

/**
 * Session states under which a provider's background tasks can still be alive.
 * Anything else (stopped, interrupted, error, idle, no session) means the
 * provider process is gone, and its children with it — reporting tasks as
 * running past that point would strand a permanent Working state.
 *
 * Mirrors the server-side aggregate in ProjectionPipeline's
 * refreshThreadShellSummary; keep the two in sync.
 */
const TASK_BEARING_SESSION_STATUSES: ReadonlySet<OrchestrationSession["status"]> = new Set([
  "starting",
  "running",
  "ready",
]);

interface MutableTask {
  taskId: string;
  name: string | null;
  startedAt: string;
  status: BackgroundTaskStatus;
  latestProgress: string | null;
  latestProgressAt: string | null;
  settledAt: string | null;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// Total order: unsequenced (pre-sequence) rows sort first as a group, so
// mixing them with sequenced rows cannot produce a non-transitive comparison
// and an arbitrary replay order. Mirrors the server-side comparator in
// ProjectionPipeline's deriveOutstandingBackgroundTasks.
function compareActivities(a: OrchestrationThreadActivity, b: OrchestrationThreadActivity): number {
  const aSequence = a.sequence ?? Number.NEGATIVE_INFINITY;
  const bSequence = b.sequence ?? Number.NEGATIVE_INFINITY;
  if (aSequence !== bSequence) return aSequence < bSequence ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toTerminalStatus(value: unknown): BackgroundTaskStatus {
  return value === "failed" || value === "stopped" ? value : "completed";
}

/**
 * Replays task.started/task.progress/task.completed activities into the set of
 * provider background tasks (subagents) for a thread. Duplicate lifecycle
 * events are idempotent, a completed for an unknown task is ignored, and a
 * started/progress arriving after its task settled stays settled, so stale or
 * repeated events cannot resurrect a permanent Working state (#4962).
 */
export function deriveBackgroundTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  session: Pick<OrchestrationSession, "status"> | null,
): BackgroundTaskState {
  if (session === null || !TASK_BEARING_SESSION_STATUSES.has(session.status)) {
    return EMPTY_STATE;
  }

  const tasks = new Map<string, MutableTask>();
  const ordered = [...activities].sort(compareActivities);
  for (const activity of ordered) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    const taskId = nonEmptyString(payload?.taskId);
    if (!taskId) continue;

    const existing = tasks.get(taskId);
    if (activity.kind === "task.completed") {
      // A terminal event for a task we never saw start is stale noise.
      if (!existing) continue;
      if (existing.settledAt !== null) continue;
      existing.status = toTerminalStatus(payload?.status);
      existing.settledAt = activity.createdAt;
      continue;
    }

    // Settled wins: a late or duplicated started/progress cannot reopen a task.
    if (existing?.settledAt) continue;

    const name =
      activity.kind === "task.started"
        ? (nonEmptyString(payload?.detail) ?? nonEmptyString(payload?.taskType))
        : nonEmptyString(payload?.title);
    const progress =
      activity.kind === "task.progress"
        ? (nonEmptyString(payload?.summary) ?? nonEmptyString(payload?.detail))
        : null;

    if (existing) {
      existing.name ??= name;
      if (progress !== null) {
        existing.latestProgress = progress;
        existing.latestProgressAt = activity.createdAt;
      }
      continue;
    }
    tasks.set(taskId, {
      taskId,
      name,
      startedAt: activity.createdAt,
      status: "running",
      latestProgress: progress,
      latestProgressAt: progress === null ? null : activity.createdAt,
      settledAt: null,
    });
  }

  const running: BackgroundTask[] = [];
  const settled: BackgroundTask[] = [];
  for (const task of tasks.values()) {
    const finished: BackgroundTask = { ...task, name: task.name ?? FALLBACK_TASK_NAME };
    if (finished.status === "running") running.push(finished);
    else settled.push(finished);
  }
  settled.sort((a, b) => (a.settledAt! < b.settledAt! ? 1 : a.settledAt! > b.settledAt! ? -1 : 0));

  // Min-scan rather than first-inserted: replay order follows sequence, which
  // can disagree with createdAt under clock skew, and the elapsed label must
  // count from the genuinely oldest running task.
  let startedAt: string | null = null;
  for (const task of running) {
    if (startedAt === null || task.startedAt < startedAt) startedAt = task.startedAt;
  }

  return { running, settled, startedAt };
}
