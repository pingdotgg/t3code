import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "../environment/scoped.ts";
import {
  taskWorkbenchRef,
  workbenchTerminalAttachInput,
  resolveWorkbenchOwner,
  canLaunchWorkbench,
} from "./taskWorkbench.ts";

const environmentId = EnvironmentId.make("one");
const task = { environmentId, id: TaskId.make("task") };
const first = scopeThreadRef(environmentId, ThreadId.make("first"));
const second = scopeThreadRef(environmentId, ThreadId.make("second"));

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
  it("isolates identical task and project IDs across environments and restores standalone ownership", () => {
    const other = EnvironmentId.make("two");
    const resolved = resolveWorkbench(input);
    const remote = resolveWorkbench({
      ...input,
      threadRef: scopeThreadRef(other, first.threadId),
      thread: { ...input.thread!, environmentId: other },
      task: { ...input.task!, environmentId: other },
      projects: [{ ...primary, environmentId: other }],
    });
    expect(remote).toMatchObject({
      status: "ready",
      ownerRef: { environmentId: other, threadId: "task:task" },
    });
    expect(remote).not.toEqual(resolved);
    expect(
      resolveWorkbench({ ...input, thread: { ...input.thread!, taskId: null } }),
    ).toMatchObject({ status: "ready", ownerRef: first });
    expect(
      resolveWorkbench({ ...input, thread: { ...input.thread!, environmentId: other } }).status,
    ).toBe("unavailable");
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
    expect(resolveWorkbench({ ...input, authoritative: false })).toMatchObject({
      status: "ready",
      launchAllowed: false,
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

describe("display and launch transitions", () => {
  it("retains cached metadata, blocks launch, and resumes against current roots", () => {
    for (const authoritative of [true, false, true]) {
      const resolved = resolveWorkbench({ ...input, authoritative });
      expect(resolved).toMatchObject({ status: "ready", cwd: "/primary" });
      expect(canLaunchWorkbench(resolved)).toBe(authoritative);
    }
    expect(resolveWorkbench({ ...input, authoritative: false, projects: [] })).toEqual({
      status: "unavailable",
      reason: "loading",
    });
    expect(
      resolveWorkbench({ ...input, projects: [{ ...primary, workspaceRoot: "/current" }] }),
    ).toMatchObject({ status: "ready", cwd: "/current", launchAllowed: true });
    expect(resolveWorkbench({ ...input, tasksSupported: undefined })).toMatchObject({
      status: "ready",
      launchAllowed: false,
      ownerRef: taskWorkbenchRef({ environmentId, taskId: task.id }),
    });
  });
  it("resolves panel identity without projects and refuses missing members", () => {
    expect(resolveWorkbenchOwner({ ...input, thread: { ...input.thread!, taskId: null } })).toEqual(
      { status: "ready", ownerRef: first },
    );
    expect(resolveWorkbenchOwner(input)).toEqual({
      status: "ready",
      ownerRef: taskWorkbenchRef({ environmentId, taskId: task.id }),
    });
    expect(resolveWorkbenchOwner({ ...input, task: null, authoritative: false })).toEqual({
      status: "unavailable",
      reason: "loading",
    });
    expect(resolveWorkbenchOwner({ ...input, thread: null })).toEqual({
      status: "unavailable",
      reason: "missing",
    });
  });
});
