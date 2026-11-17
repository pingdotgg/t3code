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
    subtasks: ["completed", "running"],
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

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
const failure = (status: number, code: string, message: string) =>
  json(status, { status, error: { code, message, details: {} } });

/** A Gateway transport that answers the two Conn Tasks routes from fixtures. */
export function fixtureOrbitTasksTransport(
  scenario: OrbitTasksFixtureScenario = "default",
): OrbitGatewayTransport {
  const details = scenario === "empty" ? [] : ORBIT_TASK_FIXTURES.map(detailOf);
  return async (request) => {
    switch (scenario) {
      case "not-a-node":
        return failure(403, "peer.identity_unknown", "This address is not an active Node.");
      case "access-required":
        return failure(403, "node_access.required", "This Node has no access to the Gateway.");
      case "extension-disabled":
        return failure(404, "extension.disabled", "The Tasks extension is disabled.");
      case "unreachable":
        throw new Error("connect ECONNREFUSED");
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
