import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import type {
  AgentActivityPhase,
  AgentActivityProps,
  AgentActivityRowProps,
} from "../../widgets/AgentActivity";

/**
 * Agent work shown by the agent-activity scene. The rows point at
 * seeded showcase threads so the copy matches the thread list, but the phases
 * are staged: the relay that normally derives them is not part of the capture.
 * Rows follow the relay's order: attention first, then running, then finished.
 */
export const SHOWCASE_AGENT_ACTIVITY_ROWS = [
  { threadId: "pocket-command-center", phase: "waiting_for_approval", minutesAgo: 1 },
  { threadId: "beautiful-boot", phase: "waiting_for_input", minutesAgo: 4 },
  { threadId: "buttery-suspense", phase: "running", minutesAgo: 2 },
  { threadId: "remote-command-center", phase: "completed", minutesAgo: 3 },
] as const satisfies ReadonlyArray<{
  readonly threadId: string;
  readonly phase: AgentActivityPhase;
  readonly minutesAgo: number;
}>;

// Matches the relay's row wording (AgentActivityPublisher.statusForPhase).
const STATUS_BY_PHASE: Record<AgentActivityPhase, string> = {
  starting: "Connecting",
  running: "Working",
  waiting_for_approval: "Approval",
  waiting_for_input: "Input",
  stale: "Waiting",
  completed: "Done",
  failed: "Failed",
};

const ACTIVE_PHASES: ReadonlySet<AgentActivityPhase> = new Set([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

/** Returns null until every staged thread and its project have loaded. */
export function buildShowcaseAgentActivity(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  now: number,
): AgentActivityProps | null {
  const rows: AgentActivityRowProps[] = [];
  for (const definition of SHOWCASE_AGENT_ACTIVITY_ROWS) {
    const thread = threads.find((candidate) => String(candidate.id) === definition.threadId);
    const project = thread
      ? projects.find(
          (candidate) =>
            candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
        )
      : undefined;
    if (!thread || !project) return null;
    const environmentId = String(thread.environmentId);
    rows.push({
      environmentId,
      threadId: definition.threadId,
      projectTitle: project.title,
      threadTitle: thread.title,
      modelTitle: "",
      phase: definition.phase,
      status: STATUS_BY_PHASE[definition.phase],
      updatedAt: new Date(now - definition.minutesAgo * 60_000).toISOString(),
      deepLink: `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(definition.threadId)}`,
    });
  }
  return {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: rows.filter((row) => ACTIVE_PHASES.has(row.phase)).length,
    updatedAt: new Date(now).toISOString(),
    activities: rows,
  };
}

/** The alert the relay sends when the hero row starts waiting on the user. */
export function showcaseAgentAlert(activity: AgentActivityProps) {
  const row = activity.activities[0];
  if (!row) return null;
  return {
    title: row.threadTitle,
    body: `${row.status}: ${row.projectTitle}`,
    path: row.deepLink,
    environmentId: row.environmentId,
    threadId: row.threadId,
  };
}

/**
 * The FCM data map Android's native receiver renders, mirroring the relay's
 * androidActivityData so the shade shows exactly what a real push produces.
 */
export function showcaseAndroidActivityData(
  activity: AgentActivityProps,
  now: number,
): Record<string, string> {
  const attentionCount = activity.activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  ).length;
  const hero = activity.activities[0];
  const alert = showcaseAgentAlert(activity);
  return {
    t3_kind: "agent_activity",
    updated_at: String(now),
    active: String(activity.activeCount > 0),
    activity_chip: attentionCount > 0 ? "Review" : "Active",
    activity_title: `${activity.activeCount} active agents · ${attentionCount} need attention`,
    activity_phase: hero?.phase ?? "",
    activity_active_count: String(activity.activeCount),
    activity_attention_count: String(attentionCount),
    activity_body: hero ? `${hero.status}: ${hero.threadTitle} · ${hero.projectTitle}` : "",
    ...Object.fromEntries(
      activity.activities.map((row, index) => [
        `activity_line_${index}`,
        [row.status, row.threadTitle, row.projectTitle].join("\t"),
      ]),
    ),
    activity_path: hero?.deepLink ?? "/",
    activity_expires_at: String(now + 2 * 60 * 60_000),
    ...(alert
      ? {
          alert_id: "showcase-alert",
          alert_title: alert.title,
          alert_body: alert.body,
          alert_path: alert.path,
        }
      : {}),
  };
}
