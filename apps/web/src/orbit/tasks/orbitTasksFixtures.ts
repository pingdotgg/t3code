import type { OrbitGatewayTransport } from "@t3tools/client-runtime/orbit-gateway";

import type { OrbitTasksFixtureScenario } from "./orbitTasksClient";

// Dev and test data only, in the Gateway's wire form so it runs through the real decoder.
// Dev builds use it only when localStorage `conn:orbit-tasks-fixture` names a scenario.

const ENV = "a5bf17aa-d514-4c78-a644-edf55dba343f";
const AT = "2026-11-17T16:11:09+00:00";
const NO_METRICS = { duration_ms: null, tokens: null, lines_added: null, lines_deleted: null };

type Status =
  | "backlog"
  | "todo"
  | "reserved"
  | "running"
  | "reviewing"
  | "settling"
  | "waiting_for_review"
  | "completed"
  | "failed"
  | "cancelled";
type SubStatus =
  | "todo"
  | "reserved"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";
type Attention = {
  kind: "question" | "failure" | "direction" | "observation" | "removal_failure";
  question: string | null;
  reason: string | null;
} | null;

interface FixtureInput {
  id: number;
  title: string;
  status: Status;
  subtasks: SubStatus[];
  attention?: Attention;
  workspace?: "none" | "running" | "stopped" | "no-conn" | "removed";
  pr?: { number: number; state: "open" | "merged" | "closed" | null };
  durationMinutes?: number;
  lines?: [number, number];
  /** Future Orbit mode; Orbit runs every task per subtask today. */
  shared?: true;
  /** Subtask positions (1-based) whose first implementer attempt was replaced. */
  replaced?: number[];
  /** Subtask positions that went through a review. */
  reviewed?: number[];
}

const SUBTASK_TITLES = [
  "Upload limits per provider",
  "Attachment chips in the composer",
  "Paste and drop handling",
  "iOS photo picker",
];

function workspaceOf(input: FixtureInput) {
  const kind =
    input.workspace ?? (input.status === "backlog" || input.status === "todo" ? "none" : "running");
  if (kind === "none") return null;
  return {
    instance_id: 3000 + input.id,
    name: `task-${input.id}`,
    status: kind === "removed" ? "removed" : "active",
    power_state: kind === "stopped" ? "stopped" : kind === "removed" ? null : "running",
    node: { id: 9, name: "beast" },
    branch: `task-${input.id}`,
    conn_environment_id: kind === "running" ? ENV : null,
  };
}

function detailOf(input: FixtureInput) {
  const reachable = workspaceOf(input)?.conn_environment_id != null;
  let agentId = input.id * 10;
  const agents: unknown[] = [];
  const addAgent = (
    role: "implementer" | "reviewer",
    subtaskIds: number[],
    current: boolean,
    attempt: number,
    state: "idle" | "working" | "asking_for_input" | "done" | "failed" | null,
  ) => {
    agentId += 1;
    agents.push({
      id: agentId,
      role,
      subtask_ids: subtaskIds,
      current,
      attempt,
      provider: role === "reviewer" ? "claude" : "codex",
      model: role === "reviewer" ? "claude-opus-5-5" : "gpt-5.5-codex",
      effort: "medium",
      state,
      needs_input: state === "asking_for_input",
      created_at: AT,
      observed_at: state === null ? null : AT,
      conn: reachable ? { environment_id: ENV, thread_id: `orbit:${input.id}-${agentId}` } : null,
    });
    return agentId;
  };
  const stateFor = (status: SubStatus) =>
    status === "running"
      ? input.attention?.kind === "question"
        ? "asking_for_input"
        : "working"
      : status === "completed"
        ? "done"
        : status === "failed"
          ? "failed"
          : "idle";
  const subtaskIds = input.subtasks.map((_, index) => input.id + index + 1);
  const sharedId =
    input.shared && input.subtasks.some((status) => status !== "todo")
      ? addAgent("implementer", subtaskIds, true, 1, "working")
      : null;
  const subtasks = input.subtasks.map((status, index) => {
    const id = subtaskIds[index]!;
    const started = status !== "todo" && status !== "reserved";
    let current: number | null = sharedId;
    if (started && !input.shared) {
      if (input.replaced?.includes(index + 1)) addAgent("implementer", [id], false, 1, "failed");
      current = addAgent(
        "implementer",
        [id],
        true,
        input.replaced?.includes(index + 1) ? 2 : 1,
        stateFor(status),
      );
    }
    if (input.reviewed?.includes(index + 1)) {
      addAgent(
        "reviewer",
        [id],
        status === "reviewing",
        1,
        status === "reviewing" ? "working" : "done",
      );
    }
    return {
      id,
      position: index + 1,
      title: SUBTASK_TITLES[index] ?? `Subtask ${index + 1}`,
      brief: `Deliver ${SUBTASK_TITLES[index] ?? `subtask ${index + 1}`}.`,
      deliverables: [{ id: "proof", type: "command", description: "Focused tests pass." }],
      status,
      attention: null,
      current_implementer_agent_id: current,
      metrics: started ? { ...NO_METRICS, duration_ms: (index + 1) * 9 * 60_000 } : NO_METRICS,
    };
  });
  const count = (status: SubStatus) => input.subtasks.filter((entry) => entry === status).length;
  return {
    id: input.id,
    title: input.title,
    status: input.status,
    attention: input.attention ?? null,
    project: { id: 78, slug: "conn", name: "Conn", code: "CON" },
    workspace: workspaceOf(input),
    pull_request: input.pr
      ? { ...input.pr, url: `https://github.com/nckrtl/conn/pull/${input.pr.number}` }
      : null,
    subtask_counts: {
      total: input.subtasks.length,
      todo: count("todo") + count("reserved"),
      running: count("running") + count("reviewing"),
      completed: count("completed"),
      failed: count("failed"),
      cancelled: count("cancelled"),
    },
    created_at: AT,
    updated_at: AT,
    last_activity_at: input.status === "backlog" ? null : AT,
    brief: `${input.title}.\n\n## Outcome\nA fixture brief for the Tasks panel.`,
    execution: { implementer_mode: input.shared ? "shared" : "per_subtask" },
    metrics: {
      duration_ms: input.durationMinutes === undefined ? null : input.durationMinutes * 60_000,
      tokens: null,
      lines_added: input.lines?.[0] ?? null,
      lines_deleted: input.lines?.[1] ?? null,
    },
    subtasks,
    agents,
  };
}

export const ORBIT_TASK_FIXTURES = [
  { id: 520, title: "Offline drafts on iOS", status: "backlog", subtasks: [] },
  {
    id: 510,
    title: "Keyboard shortcuts for the Tasks panel",
    status: "todo",
    subtasks: ["todo", "todo"],
  },
  {
    id: 482,
    title: "Image attachments in the composer",
    status: "running",
    subtasks: ["completed", "running", "todo", "todo"],
    reviewed: [1],
    pr: { number: 1931, state: "open" },
    durationMinutes: 38,
    lines: [610, 88],
  },
  {
    id: 470,
    title: "Thread search across environments",
    status: "reviewing",
    subtasks: ["completed", "completed", "reviewing"],
    reviewed: [1, 2, 3],
    pr: { number: 1902, state: "open" },
    durationMinutes: 71,
    lines: [902, 140],
  },
  {
    id: 465,
    title: "Usage limits per provider",
    status: "running",
    subtasks: ["completed", "running", "todo"],
    attention: { kind: "question", question: "Per model or per provider?", reason: null },
    durationMinutes: 22,
  },
  {
    id: 458,
    title: "Desktop auto-update channel",
    status: "running",
    subtasks: ["completed", "todo"],
    attention: { kind: "direction", question: null, reason: "Needs the signing certificate." },
    workspace: "stopped",
  },
  {
    id: 452,
    title: "Shared implementer (future Orbit mode)",
    status: "settling",
    subtasks: ["completed", "reviewing"],
    reviewed: [2],
    shared: true,
    workspace: "no-conn",
  },
  {
    id: 449,
    title: "Migrate settings storage",
    status: "failed",
    subtasks: ["completed", "failed"],
    replaced: [2],
    attention: { kind: "failure", question: null, reason: "Migration test failed twice." },
    workspace: "removed",
    durationMinutes: 54,
    lines: [312, 97],
  },
  {
    id: 440,
    title: "Legacy sync cleanup",
    status: "cancelled",
    subtasks: ["completed", "cancelled"],
    workspace: "removed",
  },
  {
    id: 431,
    title: "Right panel tab reordering",
    status: "completed",
    subtasks: ["completed", "completed"],
    reviewed: [2],
    pr: { number: 1870, state: "merged" },
    durationMinutes: 46,
    lines: [214, 61],
  },
] satisfies ReadonlyArray<FixtureInput>;

const LIST_KEYS = [
  "id",
  "title",
  "status",
  "attention",
  "project",
  "workspace",
  "pull_request",
  "subtask_counts",
  "created_at",
  "updated_at",
  "last_activity_at",
] as const;

const INSIGHTS_PERIOD_END = Date.parse("2026-11-19T00:00:00+00:00");

/** Orbit's `/task-insights` answer, shaped like its own fixture; no 6041/6042 fields yet. */
function insightsOf(period: "7d" | "30d") {
  const days = period === "7d" ? 7 : 30;
  const scale = days / 30;
  const summary = (
    merged: number,
    tokensPerPr: number,
    leadMinutes: number,
    firstPass: number,
  ) => ({
    tasks: Math.round(merged * 1.4),
    merged,
    excluded: 2,
    tokens: Math.round(merged * tokensPerPr * 1.2),
    cost_usd: merged * 3.1,
    tokens_per_merged_pr: tokensPerPr,
    cost_per_merged_pr: 3.1,
    lead_time_ms: leadMinutes * 60_000,
    queue_ms: 1_800_000,
    work_ms: 9_720_000,
    merge_wait_ms: 3_600_000,
    yield: 0.71,
    pr_first_pass: firstPass,
    wasted_share: 0.15,
    subtask_first_pass: 0.64,
    review_rounds: 1.3,
    handoff_first_try: 0.74,
    questions_per_task: 0.4,
    questions_by_cause: {},
    cache_hit: 0.86,
    tokens_per_hundred_lines: 4100,
  });
  const day = (offset: number) =>
    new Date(INSIGHTS_PERIOD_END - offset * 86_400_000).toISOString().slice(0, 10);
  return {
    data: {
      period,
      from: `${day(days)}T00:00:00+00:00`,
      to: `${day(0)}T00:00:00+00:00`,
      current: summary(Math.round(117 * scale), 1_410_000, 179, 0.63),
      previous: {
        ...summary(Math.round(128 * scale), 1_550_000, 195, 0.63),
        review_rounds: 1.5,
        wasted_share: 0.18,
      },
      weekly: Array.from({ length: 12 }, (_, index) => ({
        week_start: day((12 - index) * 7),
        tasks: 30,
        merged: 24,
        tokens_per_merged_pr:
          index === 4 ? null : 1_900_000 - index * 40_000 + (index % 3) * 90_000,
      })),
      daily: Array.from({ length: days }, (_, index) => ({
        date: day(days - index),
        merged: [3, 5, 4, 2, 6, 4, 3, 1, 5, 7, 2, 4, 6, 3][index % 14]! + Math.floor(index / 10),
        not_merged: index % 4 === 0 ? 1 : 0,
      })),
      breakdowns: {
        model: [
          {
            key: "gpt-5.5-codex",
            label: "gpt-5.5-codex",
            tasks: 70,
            merged: 61,
            tokens_per_merged_pr: 1_520_000,
            lead_time_ms: 9_900_000,
            yield: 0.87,
          },
          {
            key: "claude-opus-5-5",
            label: "claude-opus-5-5",
            tasks: 40,
            merged: 36,
            tokens_per_merged_pr: 1_310_000,
            lead_time_ms: 11_400_000,
            yield: 0.9,
          },
          {
            key: "gemini-3-pro",
            label: "gemini-3-pro",
            tasks: 25,
            merged: 20,
            tokens_per_merged_pr: 1_180_000,
            lead_time_ms: 12_600_000,
            yield: 0.8,
          },
        ],
        project: [],
        release: [],
      },
    },
  };
}

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
const failure = (status: number, code: string, message: string) =>
  json(status, { status, error: { code, message, details: {} } });

/** A Gateway transport that answers the two Conn Tasks routes from fixtures. */
export function fixtureOrbitTasksTransport(
  scenario: OrbitTasksFixtureScenario = "default",
  overrides?: () => {
    conversation?: { environmentId: string; threadId: string };
    pullRequest?: { number: number; url: string };
    tokens?: number;
    /** Answers the insights read the way the Gateway did before Orbit 6040. */
    insightsFailure?: boolean;
  },
): OrbitGatewayTransport {
  return async (request) => {
    const options = overrides?.();
    const details =
      scenario === "empty"
        ? []
        : ORBIT_TASK_FIXTURES.map((input) => {
            const detail = detailOf(input);
            if (input.id !== 482 || !options) return detail;
            return {
              ...detail,
              agents: options.conversation
                ? detail.agents.map((agent) => ({
                    ...(agent as Record<string, unknown>),
                    conn: {
                      environment_id: options.conversation!.environmentId,
                      thread_id: options.conversation!.threadId,
                    },
                  }))
                : detail.agents,
              workspace:
                options.conversation && detail.workspace
                  ? { ...detail.workspace, conn_environment_id: options.conversation.environmentId }
                  : detail.workspace,
              pull_request: options.pullRequest
                ? { ...options.pullRequest, state: "open" }
                : detail.pull_request,
              metrics:
                options.tokens === undefined
                  ? detail.metrics
                  : { ...detail.metrics, tokens: options.tokens },
            };
          });
    switch (scenario) {
      case "not-a-node":
        return failure(403, "peer.identity_unknown", "This address is not an active Node.");
      case "access-required":
        return failure(403, "node_access.required", "This Node has no access to the Gateway.");
      case "extension-disabled":
        return failure(409, "extension.disabled", "The Tasks extension is disabled.");
      case "unreachable":
        throw new Error("connect ECONNREFUSED");
    }
    if (request.path === "/task-insights") {
      return options?.insightsFailure
        ? failure(500, "gateway.unhandled", "The gateway could not complete the request.")
        : json(200, insightsOf(request.query?.period === "7d" ? "7d" : "30d"));
    }
    if (request.path === "/tasks") {
      const rows = details.map((detail) =>
        Object.fromEntries(LIST_KEYS.map((key) => [key, detail[key]])),
      );
      return json(200, { data: rows, meta: { next_cursor: null } });
    }
    const id = Number(/^\/tasks\/(\d+)$/.exec(request.path)?.[1]);
    const detail = details.find((entry) => entry.id === id);
    return detail ? json(200, { data: detail }) : failure(404, "http.404", "Not found.");
  };
}
