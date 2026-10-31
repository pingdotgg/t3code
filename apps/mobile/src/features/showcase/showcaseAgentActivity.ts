import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import type {
  AgentActivityPhase,
  AgentActivityProps,
  AgentActivityRowProps,
} from "../../widgets/AgentActivity";

interface ShowcaseAgentActivityRow {
  readonly threadId: string;
  readonly phase: AgentActivityPhase;
  readonly minutesAgo: number;
}

const fixLoginRedirect = (phase: AgentActivityPhase): ShowcaseAgentActivityRow => ({
  threadId: "fix-login-redirect",
  phase,
  minutesAgo: 1,
});
const updateSnapshots = (phase: AgentActivityPhase): ShowcaseAgentActivityRow => ({
  threadId: "update-snapshots",
  phase,
  minutesAgo: 1,
});

// Rows follow the relay's order: threads that need the user, failures, work, then outcomes.
// With nothing in flight the relay lists the newest outcome first, so the widget must lead with failures.
const SHOWCASE_AGENT_ACTIVITY_FIXTURES = {
  store: [
    { threadId: "pocket-command-center", phase: "waiting_for_approval", minutesAgo: 1 },
    { threadId: "beautiful-boot", phase: "waiting_for_input", minutesAgo: 4 },
    { threadId: "buttery-suspense", phase: "running", minutesAgo: 2 },
    { threadId: "remote-command-center", phase: "completed", minutesAgo: 3 },
  ],
  "handoff-working": [fixLoginRedirect("running"), updateSnapshots("running")],
  "handoff-approval": [fixLoginRedirect("waiting_for_approval"), updateSnapshots("completed")],
  "handoff-input": [fixLoginRedirect("waiting_for_input"), updateSnapshots("completed")],
  "all-done": [updateSnapshots("completed"), { ...fixLoginRedirect("completed"), minutesAgo: 4 }],
  "done-with-failure": [
    updateSnapshots("completed"),
    { ...fixLoginRedirect("failed"), minutesAgo: 4 },
  ],
  "phase-starting": [fixLoginRedirect("starting")],
  "phase-running": [fixLoginRedirect("running")],
  "phase-waiting_for_approval": [fixLoginRedirect("waiting_for_approval")],
  "phase-waiting_for_input": [fixLoginRedirect("waiting_for_input")],
  "phase-completed": [fixLoginRedirect("completed")],
  "phase-failed": [fixLoginRedirect("failed")],
  "phase-stale": [fixLoginRedirect("stale"), updateSnapshots("stale")],
} as const satisfies Record<string, ReadonlyArray<ShowcaseAgentActivityRow>>;

export type ShowcaseAgentActivityFixture = keyof typeof SHOWCASE_AGENT_ACTIVITY_FIXTURES;

export function parseShowcaseAgentActivityFixture(
  value: string | undefined,
): ShowcaseAgentActivityFixture {
  return value !== undefined && Object.hasOwn(SHOWCASE_AGENT_ACTIVITY_FIXTURES, value)
    ? (value as ShowcaseAgentActivityFixture)
    : "store";
}

const STATUS_BY_PHASE: Record<AgentActivityPhase, string> = {
  starting: "Connecting",
  running: "Working",
  waiting_for_approval: "Approval",
  waiting_for_input: "Input",
  stale: "Waiting",
  completed: "Done",
  failed: "Failed",
};

const TERMINAL_PHASES: ReadonlySet<AgentActivityPhase> = new Set(["completed", "failed"]);

/** Returns null until every staged thread and its project have loaded. */
export function buildShowcaseAgentActivity(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  now: number,
  fixture: ShowcaseAgentActivityFixture = "store",
): AgentActivityProps | null {
  const rows: AgentActivityRowProps[] = [];
  for (const definition of SHOWCASE_AGENT_ACTIVITY_FIXTURES[fixture]) {
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
  const activeCount = rows.filter((row) => !TERMINAL_PHASES.has(row.phase)).length;
  return {
    title: "T3 Code",
    subtitle:
      activeCount > 0
        ? "Agent work in progress"
        : rows.some((row) => row.phase === "failed")
          ? "Agent work failed"
          : "Agent work completed",
    activeCount,
    updatedAt: new Date(now).toISOString(),
    activities: rows,
  };
}

function showcaseAgentAlert(activity: AgentActivityProps) {
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

/** Matches the relay's androidActivityData FCM map for native rendering. */
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
