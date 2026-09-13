import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "../environment/scoped.ts";
import {
  taskWorkbenchRef,
  workbenchRefFor,
  workbenchTerminalAttachInput,
} from "./taskWorkbench.ts";

const environmentId = EnvironmentId.make("one");
const task = { environmentId, id: TaskId.make("task") };
const first = scopeThreadRef(environmentId, ThreadId.make("first"));
const second = scopeThreadRef(environmentId, ThreadId.make("second"));

describe("task workbench resource identity", () => {
  it("shares sibling resources without changing their real refs", () => {
    const owner = workbenchRefFor(first, { taskId: task.id }, task);
    expect(owner).toEqual(workbenchRefFor(second, { taskId: task.id }, task));
    expect(owner.threadId).toBe("task:task");
    expect(first.threadId).toBe("first");
    expect(workbenchRefFor(second, { taskId: null }, task)).toBe(second);
  });

  it("opens an empty task and isolates duplicate IDs on other environments", () => {
    const empty = taskWorkbenchRef({ environmentId, taskId: task.id });
    expect(empty).toEqual(workbenchRefFor(first, { taskId: task.id }, task));
    expect(
      taskWorkbenchRef({ environmentId: EnvironmentId.make("two"), taskId: task.id }),
    ).not.toEqual(empty);
    expect(
      workbenchRefFor(
        first,
        { taskId: task.id },
        { ...task, environmentId: EnvironmentId.make("two") },
      ),
    ).toBe(first);
  });

  it("keeps standalone resources when membership cannot be resolved", () => {
    expect(workbenchRefFor(first, { taskId: task.id }, null)).toBe(first);
    expect(workbenchRefFor(first, { taskId: TaskId.make("different") }, task)).toBe(first);
    expect(
      workbenchRefFor(first, { taskId: task.id, environmentId: EnvironmentId.make("two") }, task),
    ).toBe(first);
  });
});

import { ProjectId } from "@t3tools/contracts";
import { resolveWorkbench, type WorkbenchInput } from "./taskWorkbench.ts";
const primary = { environmentId, id: ProjectId.make("primary"), workspaceRoot: "/primary" };
const foreign = { environmentId, id: ProjectId.make("foreign"), workspaceRoot: "/foreign" };
const input: WorkbenchInput = {
  threadRef: first,
  thread: { environmentId, taskId: task.id, projectId: foreign.id, worktreePath: "/checkout" },
  task: { ...task, primaryProjectId: primary.id },
  projects: [primary, foreign],
  tasksSupported: true,
  authoritative: true,
};
describe("resolved workbench", () => {
  it("resolves siblings, a foreign member and an empty task identically", () => {
    const resolved = resolveWorkbench(input);
    expect(resolved).toMatchObject({
      status: "ready",
      ownerRef: taskWorkbenchRef({ environmentId, taskId: task.id }),
      projectRef: { environmentId, projectId: primary.id },
      cwd: "/primary",
      workspaceRoot: "/primary",
      worktreePath: null,
    });
    expect(resolveWorkbench({ ...input, threadRef: second })).toEqual(resolved);
    expect(
      resolveWorkbench({
        ...input,
        thread: null,
        threadRef: null,
        taskRef: { environmentId, taskId: task.id },
      }),
    ).toEqual(resolved);
  });
  it("keeps old-server tools on the member checkout", () => {
    expect(resolveWorkbench({ ...input, tasksSupported: false, task: null })).toMatchObject({
      status: "ready",
      ownerRef: first,
      cwd: "/checkout",
      workspaceRoot: "/foreign",
    });
  });
  it("does not authorize launches from a cached task snapshot", () => {
    expect(resolveWorkbench({ ...input, authoritative: false })).toEqual({
      status: "unavailable",
      reason: "loading",
    });
  });
  it("blocks missing task/project shells and distinguishes authoritative removal", () => {
    expect(resolveWorkbench({ ...input, task: null, authoritative: false })).toEqual({
      status: "unavailable",
      reason: "loading",
    });
    expect(resolveWorkbench({ ...input, task: null })).toEqual({
      status: "unavailable",
      reason: "missing",
    });
    expect(resolveWorkbench({ ...input, projects: [foreign] }).status).toBe("unavailable");
    expect(resolveWorkbench({ ...input, thread: null }).status).toBe("unavailable");
  });
  it("validates scoped primary-project identity and updates roots without changing owner", () => {
    expect(
      resolveWorkbench({
        ...input,
        projects: [{ ...primary, environmentId: EnvironmentId.make("two") }, foreign],
      }).status,
    ).toBe("unavailable");
    expect(
      resolveWorkbench({
        ...input,
        task: { ...input.task!, environmentId: EnvironmentId.make("two") },
      }).status,
    ).toBe("unavailable");
    expect(
      resolveWorkbench({ ...input, task: { ...input.task!, primaryProjectId: foreign.id } }),
    ).toMatchObject({
      status: "ready",
      cwd: "/foreign",
      worktreePath: null,
      ownerRef: taskWorkbenchRef({ environmentId, taskId: task.id }),
    });
    expect(
      resolveWorkbench({ ...input, task: { ...input.task!, archivedAt: "2026-09-13T00:00:00Z" } })
        .status,
    ).toBe("unavailable");
  });
});

describe("retained terminal attachment authority", () => {
  const input = {
    threadId: ThreadId.make("task:task"),
    terminalId: "terminal-1",
    cwd: "/old-project",
    worktreePath: null,
    env: { PROJECT: "/old-project" },
    restartIfNotRunning: true,
    cols: 100,
    rows: 30,
  };
  it("strips every launch field while preserving session identity and dimensions", () => {
    expect(workbenchTerminalAttachInput(input, false)).toEqual({
      threadId: "task:task",
      terminalId: "terminal-1",
      cols: 100,
      rows: 30,
    });
  });
  it("keeps the explicit location and environment when launches are authorized", () => {
    expect(workbenchTerminalAttachInput(input, true)).toEqual(input);
  });
});
