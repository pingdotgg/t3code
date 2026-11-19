import {
  createOrbitTasksClient,
  orbitTaskEnvironment,
  type OrbitTaskDetail,
  type OrbitTasksResult,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { fixtureOrbitTasksTransport } from "./orbitTasksFixtures";
import {
  agentRowInteraction,
  agentsFor,
  agentStateText,
  observeOrbitTask,
  subtaskLead,
  subtaskUsageText,
  taskUsage,
} from "./taskDetail.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function fixture(id: number) {
  const result = await createOrbitTasksClient(fixtureOrbitTasksTransport()).getTask(id);
  if (result.status !== "ok") throw new Error(result.message);
  return result.value;
}

describe("task detail", () => {
  it("shows real per-subtask implementers with state dots, keeping unstarted rows empty", async () => {
    const task = await fixture(482);
    expect(task.subtasks.map((subtask) => subtaskLead(task, subtask))).toMatchObject([
      { kind: "agent", tone: "success" },
      { kind: "agent", tone: "info" },
      { kind: "not-started" },
      { kind: "not-started" },
    ]);
    expect(agentsFor(task, task.subtasks[0]!.id).earlier.map((row) => row.label)).toEqual([
      "Reviewer",
    ]);
    const wholeTask = {
      ...task,
      agents: task.agents.map((agent) =>
        agent.role === "reviewer" ? { ...agent, subtaskIds: [], current: true } : agent,
      ),
    };
    expect(agentsFor(wholeTask, null).current.at(-1)?.label).toBe("Reviewer · whole task");
    const waiting = await fixture(465);
    expect(subtaskLead(waiting, waiting.subtasks[1]!)).toMatchObject({
      kind: "agent",
      tone: "warning",
    });
    const failed = await fixture(449);
    expect(subtaskLead(failed, failed.subtasks[1]!)).toMatchObject({
      kind: "agent",
      tone: "destructive",
    });
    const agents = agentsFor(failed, failed.subtasks[1]!.id);
    expect(agents.current.map((row) => row.label)).toEqual(["Implementer · attempt 2"]);
    expect(agents.earlier.map((row) => row.label)).toEqual(["Implementer"]);
    expect(agentStateText(agents.earlier[0]!.agent)).toBe("Failed");
    const reviewing = await fixture(470);
    const waitingReview = { ...reviewing, status: "waiting_for_review" as const };
    expect(subtaskLead(waitingReview, waitingReview.subtasks[2]!)).toMatchObject({
      kind: "agent",
      tone: "warning",
    });
  });

  it("shows a shared implementer only on the current subtask and once in task agents", async () => {
    const task = await fixture(452);
    expect(task.subtasks.map((subtask) => subtaskLead(task, subtask))).toMatchObject([
      { kind: "done" },
      { kind: "agent", tone: "info" },
    ]);
    expect(agentsFor(task, null).current.map((row) => row.label)).toEqual([
      "Implementer · all subtasks",
      "Reviewer · Attachment chips in the composer",
    ]);
    expect(subtaskLead({ ...task, status: "waiting_for_review" }, task.subtasks[1]!)).toMatchObject(
      { kind: "agent", tone: "warning" },
    );
    for (const subtask of task.subtasks) {
      expect(agentsFor(task, subtask.id).current.map((row) => row.label)).toEqual(
        subtask.status === "completed"
          ? ["Implementer · all subtasks"]
          : ["Implementer · all subtasks", "Reviewer"],
      );
    }
  });

  it("keeps missing conversations noninteractive for disposed and stopped workspaces", async () => {
    for (const [id, kind] of [
      [449, "disposed"],
      [458, "stopped"],
    ] as const) {
      const task = await fixture(id);
      expect(orbitTaskEnvironment(task).kind).toBe(kind);
      expect(agentsFor(task, null).current.map(agentRowInteraction)).toEqual([
        "text",
        ...(id === 449 ? ["text"] : []),
      ]);
    }
    const task = await fixture(482);
    expect(agentsFor(task, null).current.map(agentRowInteraction)).toEqual(["button", "button"]);
  });

  it("distinguishes unknown metrics from zero and keeps Orbit's task totals", async () => {
    const task = await fixture(482);
    expect(taskUsage(task.metrics)).toMatchObject({
      text: "38m · –",
      lines: { added: 610, deleted: 88 },
    });
    expect(taskUsage(task.metrics).description).toContain("across all attempts");
    const none = { durationMs: null, tokens: null, linesAdded: null, linesDeleted: null };
    expect(taskUsage(none).text).toBe("–");
    expect(taskUsage({ ...none, tokens: 2_000_000 }).text).toBe("– · 2M tokens");
    expect(taskUsage({ durationMs: 0, tokens: 0, linesAdded: 0, linesDeleted: 0 })).toMatchObject({
      text: "0s · 0 tokens",
      lines: { added: 0, deleted: 0 },
    });
    expect(
      subtaskUsageText({ durationMs: null, tokens: null, linesAdded: null, linesDeleted: null }),
    ).toBeNull();
    expect(
      subtaskUsageText({ durationMs: 60_000, tokens: 0, linesAdded: null, linesDeleted: null }),
    ).toBe("1m · 0 tokens");
    const shared = await fixture(452);
    expect(taskUsage({ ...shared.metrics, tokens: 123 }).text).toContain("123 tokens");
  });

  it("re-reads matching invalidations, preserves data during refresh, and ignores stale or disposed reads", async () => {
    const base = fixtureOrbitTasksTransport();
    const pending: Array<{
      resolve: (value: Awaited<ReturnType<typeof base>>) => void;
    }> = [];
    const client = createOrbitTasksClient(() => {
      const response = deferred<Awaited<ReturnType<typeof base>>>();
      pending.push({ resolve: response.resolve });
      return response.promise;
    });
    const reads: Array<Promise<OrbitTasksResult<OrbitTaskDetail>>> = [];
    const observedClient = {
      ...client,
      getTask: (id: number) => {
        const result = client.getTask(id);
        reads.push(result);
        return result;
      },
    };
    const seen: Array<OrbitTasksResult<OrbitTaskDetail>> = [];
    const stop = observeOrbitTask(observedClient, 482, (result) => seen.push(result));
    const settle = async (
      index: number,
      error: false | true | { status: number; code: string } = false,
    ) => {
      const entry = pending[index]!;
      entry.resolve(
        error
          ? error === true
            ? { status: 503, body: "unavailable" }
            : {
                status: error.status,
                body: JSON.stringify({ error: { code: error.code, message: error.code } }),
              }
          : await base({ method: "GET", path: "/tasks/482" }),
      );
      await reads[index];
    };
    await settle(0);
    expect(seen).toHaveLength(1);
    client.invalidate({ kind: "task", taskId: 470 });
    expect(pending).toHaveLength(1);
    client.invalidate({ kind: "task", taskId: 482 });
    expect(seen).toHaveLength(1);
    await settle(1, true);
    expect(seen).toHaveLength(1);
    client.invalidate({ kind: "list" });
    client.invalidate({ kind: "task", taskId: 482 });
    await settle(2);
    expect(seen).toHaveLength(1);
    await settle(3);
    expect(seen).toHaveLength(2);
    let index = 4;
    for (const error of [
      { status: 404, code: "http.404", reason: "not-found" },
      { status: 403, code: "node_access.required", reason: "access-required" },
      { status: 403, code: "peer.identity_unknown", reason: "not-a-node" },
      { status: 409, code: "extension.disabled", reason: "extension-disabled" },
    ]) {
      client.invalidate({ kind: "list" });
      await settle(index++, error);
      expect(seen.at(-1)).toMatchObject({ status: "error", reason: error.reason });
      client.invalidate({ kind: "list" });
      await settle(index++);
      expect(seen.at(-1)?.status).toBe("ok");
    }
    const observed = seen.length;
    client.invalidate({ kind: "list" });
    stop();
    await settle(index);
    client.invalidate({ kind: "list" });
    expect(pending).toHaveLength(index + 1);
    expect(seen).toHaveLength(observed);
  });

  it("reports initial errors and recovers on the next invalidation", async () => {
    const base = fixtureOrbitTasksTransport();
    let fail = true;
    const client = createOrbitTasksClient((request) =>
      fail ? Promise.resolve({ status: 503, body: "unavailable" }) : base(request),
    );
    const next = deferred<OrbitTasksResult<OrbitTaskDetail>>();
    const recovered = deferred<OrbitTasksResult<OrbitTaskDetail>>();
    const stop = observeOrbitTask(client, 482, (result) => {
      if (result.status === "error") next.resolve(result);
      else recovered.resolve(result);
    });
    expect((await next.promise).status).toBe("error");
    fail = false;
    client.invalidate({ kind: "list" });
    expect((await recovered.promise).status).toBe("ok");
    stop();
  });
});
