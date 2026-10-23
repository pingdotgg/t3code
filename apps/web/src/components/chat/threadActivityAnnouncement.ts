import type { OrchestrationV2Run, OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

export type ThreadActivityStatus = "working" | "approval" | "input" | "idle";

export interface ThreadActivitySnapshot {
  readonly status: ThreadActivityStatus;
  /** The pending approval or question, when there is one. */
  readonly requestId: string | null;
  readonly runId: RunId | null;
  readonly runStatus: OrchestrationV2RunStatus | null;
}

export interface ThreadAnnouncementMemory {
  readonly snapshot: ThreadActivitySnapshot;
  /**
   * The turn under way: the run it belongs to, "unknown" until that run shows
   * up, or null between turns. Its ending is announced once, then it clears.
   */
  readonly turnRunId: RunId | "unknown" | null;
  /** The run whose ending is already known, so a stale run is never announced as this turn's. */
  readonly settledRunId: RunId | null;
  /** The run shown while idle belongs to the last turn, even if it is still settling. */
  readonly idleRunId: RunId | null;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus | null> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const STARTING_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus | null> = new Set([
  "queued",
  "preparing",
  "starting",
]);

function runOutcomeText(status: OrchestrationV2RunStatus | null): string | null {
  switch (status) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "interrupted":
    case "cancelled":
      return "Stopped";
    default:
      return null;
  }
}

interface RunState {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
}

/**
 * The thread's detail hasn't caught up with the live thread shell: it isn't
 * loaded yet, or a cached copy still shows an older run or state. Reading such
 * a frame as the baseline replays what already happened, so it's skipped.
 */
export function isDetailBehindShell(detailRun: RunState | null, shellRun: RunState | null) {
  return (
    shellRun !== null &&
    (detailRun?.runId !== shellRun.runId || detailRun.status !== shellRun.status)
  );
}

/**
 * A queued message cancelled before it started keeps its place in line, so it
 * shows up as the thread's latest run. It never ran, so the turn ended however
 * the last run that did ran.
 */
export function announcedRun(
  activityRun: (RunState & { readonly startedAt: string | null }) | null,
  runs: ReadonlyArray<OrchestrationV2Run>,
): RunState | null {
  if (activityRun?.status !== "cancelled" || activityRun.startedAt !== null) return activityRun;
  const run = latestExecutedRun(runs);
  return run === null ? null : { runId: run.id, status: run.status };
}

/**
 * Decides what a screen reader hears when the open thread's turn changes state.
 * The first snapshot of a thread is a silent baseline, so opening or switching
 * threads never replays what already happened.
 */
export function nextThreadAnnouncement(
  previous: ThreadAnnouncementMemory | null,
  next: ThreadActivitySnapshot,
): { readonly memory: ThreadAnnouncementMemory; readonly announcement: string | null } {
  const idle = next.status === "idle";
  // A run still starting up while the thread looks idle (a queued message,
  // a resume) is the next turn's, not a leftover from the last one.
  const idleRunId =
    idle && !STARTING_RUN_STATUSES.has(next.runStatus) ? next.runId : (previous?.idleRunId ?? null);
  // A run doing new work; the run left over from the last turn doesn't count.
  const newRunId =
    !idle && ACTIVE_RUN_STATUSES.has(next.runStatus) && next.runId !== idleRunId
      ? next.runId
      : null;

  if (previous === null) {
    return {
      memory: {
        snapshot: next,
        turnRunId: idle ? null : (newRunId ?? "unknown"),
        settledRunId: runOutcomeText(next.runStatus) === null ? null : next.runId,
        idleRunId,
      },
      announcement: null,
    };
  }
  const memory = { ...previous, snapshot: next, idleRunId };
  const { turnRunId } = previous;

  if (!idle) {
    // Sending can look idle for a moment before the server reports the run,
    // so a turn is tied to its run as soon as one appears, and only another
    // run taking over (a queued message starting) is a new turn.
    const turnStarted =
      turnRunId === null ||
      (newRunId !== null && turnRunId !== "unknown" && newRunId !== turnRunId);
    const nextTurnRunId =
      turnStarted || turnRunId === "unknown" ? (newRunId ?? "unknown") : turnRunId;
    const announcement =
      next.status === "approval"
        ? previous.snapshot.status === "approval" && previous.snapshot.requestId === next.requestId
          ? null
          : "Needs approval"
        : next.status === "input"
          ? previous.snapshot.status === "input" && previous.snapshot.requestId === next.requestId
            ? null
            : "Needs your input"
          : turnStarted
            ? "Working"
            : null;
    return { memory: { ...memory, turnRunId: nextTurnRunId }, announcement };
  }

  // Work can stop a moment before the run settles; the ending waits for the run.
  const outcome = runOutcomeText(next.runStatus);
  if (turnRunId === null) {
    // A run that settled unseen is history too, or the next failed send would claim it.
    const settledRunId = outcome === null ? previous.settledRunId : next.runId;
    return { memory: { ...memory, settledRunId }, announcement: null };
  }
  if (next.runStatus === "rolled_back") {
    return { memory: { ...memory, turnRunId: null, settledRunId: next.runId }, announcement: null };
  }
  if (outcome === null) return { memory, announcement: null };
  // Work stopped without a new run, e.g. a send that failed; the retry is a new turn.
  if (next.runId === previous.settledRunId) {
    return { memory: { ...memory, turnRunId: null }, announcement: null };
  }
  // The last turn's run settling while this turn waits for its own run is not this turn's ending.
  if (turnRunId === "unknown" && next.runId === previous.idleRunId) {
    return { memory: { ...memory, settledRunId: next.runId }, announcement: null };
  }
  return {
    memory: { ...memory, turnRunId: null, settledRunId: next.runId },
    announcement: outcome,
  };
}
