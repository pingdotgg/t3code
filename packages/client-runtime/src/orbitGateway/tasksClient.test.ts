import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayRequest, OrbitGatewayTransport } from "./client.ts";
import type { OrbitTasksInvalidation } from "./tasks.ts";
import { createOrbitTasksClient } from "./tasksClient.ts";
import livePage from "./fixtures/tasks-live-page.json" with { type: "json" };

// The examples from Orbit's Conn Tasks read contract v1.
const ROW = {
  id: 5753,
  title: "Executor slice 4",
  status: "running",
  attention: null,
  project: { id: 78, slug: "orbit", name: "Orbit", code: "ORB" },
  workspace: {
    instance_id: 3599,
    name: "task-5753",
    status: "active",
    power_state: "running",
    node: { id: 9, name: "beast" },
    branch: "task-5753",
    conn_environment_id: "a5bf17aa-d514-4c78-a644-edf55dba343f",
  },
  pull_request: {
    number: 3982,
    url: "https://github.com/hardimpactdev/orbit/pull/3982",
    state: "open",
  },
  subtask_counts: { total: 3, todo: 1, running: 1, completed: 1, failed: 0, cancelled: 0 },
  created_at: "2026-11-17T11:30:00+00:00",
  updated_at: "2026-11-17T16:11:09+00:00",
  last_activity_at: "2026-11-17T16:11:09+00:00",
};

const DETAIL = {
  ...ROW,
  brief: "markdown",
  execution: { implementer_mode: "per_subtask" },
  metrics: { duration_ms: 16544479, tokens: null, lines_added: 120, lines_deleted: 4 },
  subtasks: [
    {
      id: 5755,
      position: 2,
      title: "Second",
      brief: "b",
      deliverables: [],
      status: "running",
      attention: null,
      current_implementer_agent_id: 2570,
      // Orbit promises null; a stray value must not reach the UI as a subtask delta.
      metrics: { duration_ms: 60000, tokens: null, lines_added: 9, lines_deleted: 1 },
    },
    {
      id: 5754,
      position: 1,
      title: "First",
      brief: "a",
      deliverables: [{ id: "proof", type: "command", description: "d" }],
      status: "completed",
      attention: null,
      current_implementer_agent_id: 2568,
      metrics: { duration_ms: null, tokens: null, lines_added: null, lines_deleted: null },
    },
  ],
  agents: [
    {
      id: 2570,
      role: "implementer",
      subtask_ids: [5755],
      current: true,
      attempt: 1,
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "medium",
      state: "working",
      needs_input: false,
      created_at: "2026-11-17T15:00:00+00:00",
      observed_at: "2026-11-17T15:48:59+00:00",
      conn: {
        environment_id: "a5bf17aa-d514-4c78-a644-edf55dba343f",
        thread_id: "orbit:2c2312ee-9b57-4e54-90f5-71e2e95dda17",
      },
    },
    {
      id: 2568,
      role: "implementer",
      subtask_ids: [5754],
      current: true,
      attempt: 1,
      provider: "codex",
      model: null,
      effort: null,
      state: null,
      needs_input: false,
      created_at: "2026-11-17T14:00:00+00:00",
      observed_at: null,
      conn: null,
    },
  ],
};

function transport(status: number, body: unknown, seen: OrbitGatewayRequest[] = []) {
  const send: OrbitGatewayTransport = async (request) => {
    seen.push(request);
    return { status, body: JSON.stringify(body) };
  };
  return send;
}

describe("createOrbitTasksClient", () => {
  it("decodes a live Gateway page and passes its cursor back unchanged", async () => {
    const seen: OrbitGatewayRequest[] = [];
    const client = createOrbitTasksClient(transport(200, livePage, seen));
    const result = await client.listTasks({ project: 78, limit: 50 });
    expect(seen).toEqual([
      { method: "GET", path: "/tasks", query: { project: "78", limit: "50" } },
    ]);
    expect(result).toMatchObject({
      status: "ok",
      value: {
        nextCursor: "5458",
        skipped: 0,
        tasks: [
          {
            id: 5776,
            pullRequest: { number: 3989, state: "merged" },
            workspace: null,
            subtaskCounts: { total: 1, completed: 1 },
          },
        ],
      },
    });
    if (result.status !== "ok") throw new Error(result.message);
    await client.listTasks({ project: 78, limit: 50, cursor: result.value.nextCursor! });
    expect(seen[1]?.query).toEqual({ project: "78", limit: "50", cursor: "5458" });
  });

  it("orders subtasks, keeps agent ids apart from Conn threads, and never passes subtask lines", async () => {
    const result = await createOrbitTasksClient(transport(200, { data: DETAIL })).getTask(5753);
    if (result.status !== "ok") throw new Error(result.message);
    const task = result.value;
    expect(task.implementerMode).toBe("per_subtask");
    expect(task.metrics).toEqual({
      durationMs: 16544479,
      tokens: null,
      linesAdded: 120,
      linesDeleted: 4,
    });
    expect(task.subtasks.map((sub) => [sub.id, sub.metrics])).toEqual([
      [5754, { durationMs: null, tokens: null, linesAdded: null, linesDeleted: null }],
      [5755, { durationMs: 60000, tokens: null, linesAdded: null, linesDeleted: null }],
    ]);
    expect(task.agents.map((agent) => [agent.id, agent.conversation])).toEqual([
      [
        2570,
        {
          environmentId: "a5bf17aa-d514-4c78-a644-edf55dba343f",
          threadId: "orbit:2c2312ee-9b57-4e54-90f5-71e2e95dda17",
        },
      ],
      [2568, null],
    ]);
  });

  it.each([
    [403, "peer.identity_unknown", "not-a-node"],
    [403, "node_access.required", "access-required"],
    [409, "extension.disabled", "extension-disabled"],
    [404, "http.404", "not-found"],
    [500, "server.error", "unreachable"],
  ])("maps %i %s to %s", async (status, code, reason) => {
    const client = createOrbitTasksClient(
      transport(status, { status, error: { code, message: "Refused.", details: {} } }),
    );
    const expected = { status: "error", reason, message: "Refused." };
    expect.soft(await client.listTasks()).toEqual(expected);
    expect.soft(await client.getTask(1)).toEqual(expected);
  });

  it("reports a failed transport and an off-contract body", async () => {
    const down = createOrbitTasksClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await down.listTasks()).toMatchObject({ status: "error", reason: "unreachable" });
    const odd = createOrbitTasksClient(transport(200, { data: { id: 1 } }));
    expect(await odd.listTasks()).toMatchObject({ status: "error", reason: "invalid-response" });
  });

  it("reads insights below /api/v1 and leaves out only what Orbit does not report", async () => {
    const seen: OrbitGatewayRequest[] = [];
    const summary = { tasks: 31, merged: 22, tokens: 941_600_000, lead_time_ms: 15_120_000 };
    const client = createOrbitTasksClient(
      transport(
        200,
        {
          data: {
            period: "7d",
            current: { ...summary, pr_first_pass: "0.5", pr_merge_wait_ms: 3_600_000 },
            previous: {},
            weekly: [{ week_start: "2026-11-09", tokens_per_merged_pr: null }, { week: 1 }],
            daily: [{ date: "2026-11-18", merged: 3, not_merged: 1 }],
            breakdowns: { model: [{ key: "gpt-5.5", label: "gpt-5.5", merged: 4 }] },
          },
        },
        seen,
      ),
    );
    const result = await client.getTaskInsights({ period: "7d", project: 78 });
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: "/task-insights",
      query: { period: "7d", project_id: "78" },
      root: true,
    });
    expect(result).toMatchObject({
      status: "ok",
      value: {
        period: "7d",
        current: {
          merged: 22,
          leadTimeMs: 15_120_000,
          prFirstPass: null,
          prMergeWaitMs: 3_600_000,
        },
        previous: { merged: null, deliveryTimeMs: null },
        weekly: [{ weekStart: "2026-11-09", tokensPerMergedPr: null }],
        daily: [{ date: "2026-11-18", merged: 3 }],
        byModel: [{ key: "gpt-5.5", merged: 4, leadTimeMs: null }],
      },
    });
    const failing = createOrbitTasksClient(
      transport(500, { error: { code: "gateway.unhandled", message: "Not completed." } }),
    );
    expect(await failing.getTaskInsights({ period: "30d" })).toEqual({
      status: "error",
      reason: "unreachable",
      message: "Not completed.",
    });
  });

  it("skips list rows off the contract and keeps the rest", async () => {
    const client = createOrbitTasksClient(
      transport(200, {
        data: [
          { ...ROW, id: 1, status: "blocked" },
          ROW,
          { ...ROW, id: 2, attention: { kind: "escalation", question: null, reason: null } },
          { ...ROW, id: 3, pull_request: { ...ROW.pull_request, state: "draft" } },
        ],
      }),
    );
    const result = await client.listTasks();
    if (result.status !== "ok") throw new Error(result.message);
    expect(result.value.tasks.map((task) => task.id)).toEqual([5753]);
    expect(result.value.skipped).toBe(3);
  });

  it("degrades an unknown subtask or agent literal to that item, not the task", async () => {
    const [second, first] = DETAIL.subtasks;
    const [working, unobserved] = DETAIL.agents;
    const result = await createOrbitTasksClient(
      transport(200, {
        data: {
          ...DETAIL,
          subtasks: [
            {
              ...second,
              status: "paused",
              attention: { kind: "escalation", question: null, reason: null },
            },
            { ...first, attention: { kind: "escalation", question: null, reason: null } },
          ],
          agents: [{ ...working, role: "planner", state: "sleeping" }, unobserved],
        },
      }),
    ).getTask(5753);
    if (result.status !== "ok") throw new Error(result.message);
    expect(result.value.subtasks.map((sub) => [sub.id, sub.status, sub.attention])).toEqual([
      [5754, "unknown", null],
      [5755, "unknown", null],
    ]);
    expect(result.value.agents.map((agent) => [agent.id, agent.role, agent.state])).toEqual([
      [2570, "unknown", "unknown"],
      [2568, "implementer", null],
    ]);
  });

  it("tells subscribers to read again until they leave", () => {
    const client = createOrbitTasksClient(transport(200, {}));
    const seen: OrbitTasksInvalidation[] = [];
    const stop = client.onInvalidate((target) => seen.push(target));
    client.invalidate({ kind: "task", taskId: 5753 });
    stop();
    client.invalidate({ kind: "list" });
    expect(seen).toEqual([{ kind: "task", taskId: 5753 }]);
  });
});
