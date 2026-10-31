import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";

import { threadHasUnseenCompletion } from "../features/threads/threadListV2";
import type { AgentActivityPhase, AgentActivityRowProps } from "./AgentActivity";
import type { WidgetTheme } from "./widgetTheme";

// Widgets get no relay pushes, and iOS suspends the app soon after it leaves the screen;
// past this age a snapshot cannot vouch that an agent is still working.
export const AGENT_STATUS_FRESH_MS = 5 * 60_000;
// The large family shows the leading thread and seven more.
const MAX_THREADS = 8;
// Widget taps open the containing app, so its production scheme is safe in every build, as in the Live Activity.
const APP_URL = "t3code://";

export type AgentStatusRow = Pick<
  AgentActivityRowProps,
  "threadTitle" | "projectTitle" | "phase" | "updatedAt" | "deepLink"
>;

export interface AgentStatusThread {
  readonly title: string;
  readonly project: string;
  readonly phase: AgentActivityPhase;
  readonly url: string;
}

export interface AgentStatusCounts {
  readonly needsYou: number;
  readonly working: number;
  readonly failed: number;
  readonly done: number;
}

export interface AgentStatusSnapshot {
  readonly theme?: WidgetTheme;
  readonly url: string;
  readonly checkedAt: number;
  readonly expiresAt: number;
  readonly counts: AgentStatusCounts;
  readonly threads: ReadonlyArray<AgentStatusThread>;
}

// The Live Activity's order: threads that need the user, failures, work, then outcomes.
const PHASE_RANK: Record<AgentActivityPhase, number> = {
  waiting_for_approval: 0,
  waiting_for_input: 0,
  failed: 1,
  starting: 2,
  running: 2,
  completed: 3,
  stale: 3,
};

/** Rows from environments whose live shell this client holds; cached shells may be old. */
export function agentStatusRows(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<AgentStatusRow> {
  const projectByKey = new Map(
    input.projects.map((project) => [`${project.environmentId}\u0000${project.id}`, project]),
  );
  return input.threads.flatMap((thread) => {
    if (thread.archivedAt !== null || !input.liveEnvironmentIds.has(thread.environmentId)) {
      return [];
    }
    const project = projectByKey.get(`${thread.environmentId}\u0000${thread.projectId}`);
    if (!project) return [];
    // The relay projects Live Activity rows with this same function.
    const state = projectThreadAwarenessV2({
      environmentId: thread.environmentId,
      project,
      thread: thread.source,
    });
    if (state === null) return [];
    // Finished work stays until the user opens the thread, like the thread list's Done badge.
    if (
      (state.phase === "completed" || state.phase === "failed") &&
      !threadHasUnseenCompletion(thread)
    ) {
      return [];
    }
    return [
      {
        threadTitle: state.threadTitle,
        projectTitle: state.projectTitle,
        phase: state.phase,
        updatedAt: state.updatedAt,
        deepLink: state.deepLink,
      },
    ];
  });
}

export function buildAgentStatusSnapshot(
  rows: ReadonlyArray<AgentStatusRow>,
  input: { readonly now: number },
): AgentStatusSnapshot {
  const ordered = [...rows].sort(
    (a, b) =>
      PHASE_RANK[a.phase] - PHASE_RANK[b.phase] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  const count = (...phases: ReadonlyArray<AgentActivityPhase>) =>
    rows.filter((row) => phases.includes(row.phase)).length;
  return {
    url: APP_URL,
    checkedAt: input.now,
    expiresAt: input.now + AGENT_STATUS_FRESH_MS,
    counts: {
      needsYou: count("waiting_for_approval", "waiting_for_input"),
      working: count("starting", "running"),
      failed: count("failed"),
      done: count("completed"),
    },
    threads: ordered.slice(0, MAX_THREADS).map((row) => ({
      title: row.threadTitle,
      project: row.projectTitle,
      phase: row.phase,
      // deepLink is already percent-encoded; a URL builder would encode it a second time.
      url: `${APP_URL}${row.deepLink.replace(/^\//u, "")}`,
    })),
  };
}

/** What the widget shows; a thread's updatedAt changes on every event but only orders rows. */
export function agentStatusDisplayKey(rows: ReadonlyArray<AgentStatusRow> | null): string {
  if (rows === null) return "null";
  const { counts, threads } = buildAgentStatusSnapshot(rows, { now: 0 });
  return JSON.stringify({ counts, threads });
}

/** A second entry re-renders the widget when the snapshot expires, with no app running. */
export function agentStatusTimeline(snapshot: AgentStatusSnapshot) {
  return [snapshot.checkedAt, snapshot.expiresAt].map((at) => ({
    date: new Date(at),
    props: snapshot,
  }));
}
