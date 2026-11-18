import { createOrbitTasksClient } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { listAllTasks } from "./taskList";
import { fixtureOrbitTasksTransport } from "./orbitTasksFixtures";
import {
  agentRowStatus,
  agentsFor,
  subtaskLead,
  subtaskRowStatus,
  taskMatchesQuery,
  taskRowStatus,
  tasksInLane,
} from "./taskPresentation";

const client = createOrbitTasksClient(fixtureOrbitTasksTransport());

async function task(id: number) {
  const result = await client.getTask(id);
  if (result.status !== "ok") throw new Error(result.message);
  return result.value;
}

describe("mobile task presentation", () => {
  it("files tasks into lanes and searches by number, title and machine", async () => {
    const list = await client.listTasks();
    if (list.status !== "ok") throw new Error(list.message);
    const { tasks } = list.value;
    expect(tasksInLane(tasks, "in-progress").map((item) => item.id)).toEqual([482, 479]);
    expect(tasksInLane(tasks, "todo").map((item) => item.id)).toEqual([474, 487]);
    expect(tasksInLane(tasks, "backlog").map((item) => item.id)).toEqual([498, 500]);
    expect(tasksInLane(tasks, "done").map((item) => item.id)).toEqual([471]);
    expect(tasks.filter((item) => taskMatchesQuery(item, "#482")).map((item) => item.id)).toEqual([
      482,
    ]);
    expect(tasks.filter((item) => taskMatchesQuery(item, "beast")).map((item) => item.id)).toEqual([
      482, 479, 471,
    ]);
  });

  it("shows only a timer while a task runs, and names questions and blocks", async () => {
    const running = await task(482);
    expect(taskRowStatus(running, 52 * 60_000)).toMatchObject({ tone: "sky", label: null });
    expect(taskRowStatus({ ...running, status: "todo" }, null)).toBeNull();
    expect(
      taskRowStatus(
        { ...running, attention: { kind: "question", question: "Which?", reason: null } },
        null,
      ),
    ).toMatchObject({ tone: "indigo", timerMs: null });
    expect(
      taskRowStatus(
        { ...running, attention: { kind: "failure", question: null, reason: "Tests fail" } },
        null,
      ),
    ).toMatchObject({ tone: "danger" });
  });

  it("leads subtasks with their implementer's dot, and a ring before they start", async () => {
    const perSubtask = await task(482);
    expect(perSubtask.subtasks.map((subtask) => subtaskLead(perSubtask, subtask))).toMatchObject([
      { kind: "agent", dot: "success" },
      { kind: "agent", dot: "info" },
      { kind: "not-started" },
      { kind: "not-started" },
    ]);
    expect(subtaskRowStatus(perSubtask, perSubtask.subtasks[1]!)).toMatchObject({
      tone: "sky",
      timerMs: 21 * 60_000,
    });
    // One shared implementer shows only on the subtask it works on.
    const shared = await task(479);
    expect(shared.subtasks.map((subtask) => subtaskLead(shared, subtask).kind)).toEqual([
      "done",
      "agent",
      "not-started",
    ]);
  });

  it("lists implementers before the reviewer, and the shared one once", async () => {
    const perSubtask = await task(482);
    expect(agentsFor(perSubtask, null).current.map((row) => row.agent.id)).toEqual([
      4821, 4822, 4823,
    ]);
    expect(agentsFor(perSubtask, 484).current.map((row) => row.agent.id)).toEqual([4822, 4823]);
    expect(agentsFor(await task(479), null).current).toHaveLength(1);
  });

  it("ticks only for working agents and marks an agent without a conversation offline", async () => {
    const perSubtask = await task(482);
    const reviewer = perSubtask.agents.find((agent) => agent.role === "reviewer")!;
    const now = Date.parse(reviewer.createdAt) + 3 * 60_000;
    expect(agentRowStatus(reviewer, now)).toMatchObject({ tone: "sky", timerMs: 3 * 60_000 });
    expect(agentRowStatus({ ...reviewer, conversation: null }, now)).toMatchObject({
      tone: "danger",
      timerMs: null,
    });
    expect(agentRowStatus({ ...reviewer, state: "done" }, now)).toMatchObject({ timerMs: null });
  });
});

describe("listAllTasks", () => {
  it("asks for at most the Gateway's page size and follows the cursor", async () => {
    const limits: Array<number | undefined> = [];
    const result = await listAllTasks({
      listTasks: async (query = {}) => {
        limits.push(query.limit);
        const fixture = await client.listTasks({ limit: query.limit ?? 100 });
        if (fixture.status !== "ok") return fixture;
        return {
          status: "ok",
          value: {
            tasks: fixture.value.tasks.slice(query.cursor ? 4 : 0, query.cursor ? 7 : 4),
            skipped: 0,
            nextCursor: query.cursor ? null : "page-2",
          },
        };
      },
    });
    expect(limits).toEqual([100, 100]);
    expect(result.status === "ok" ? result.value.map((task) => task.id) : result).toEqual([
      482, 479, 474, 487, 498, 500, 471,
    ]);
    expect((await client.listTasks({ limit: 200 })).status).toBe("error");
  });
});
