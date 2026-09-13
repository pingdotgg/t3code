import { EnvironmentId, ProjectId, ProviderInstanceId, TaskId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentTask, EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";
import {
  applyPendingTaskSidebarDrop,
  taskSidebarDropObserved,
  type PendingTaskSidebarDrop,
} from "./Sidebar.taskPending";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const now = "2026-09-13T12:00:00.000Z";
const task = (environmentId = local): EnvironmentTask => ({
  environmentId,
  id: TaskId.make("task"),
  name: "Release",
  description: null,
  primaryProjectId: ProjectId.make("project"),
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedAt: null,
  snoozedUntil: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
});
const thread = (environmentId = local): EnvironmentThreadShell => ({
  environmentId,
  id: ThreadId.make("thread"),
  taskId: null,
  projectId: ProjectId.make("project"),
  title: "Release tests",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "release",
  worktreePath: "/workspace/release",
  pullRequests: [],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const pending = (overrides: Partial<PendingTaskSidebarDrop> = {}): PendingTaskSidebarDrop => ({
  taskPatches: new Map([["local:task", { activeOrderKey: "a1" }]]),
  threadPatches: new Map([["local:thread", { taskId: TaskId.make("task") }]]),
  receipts: new Map([[local, 42]]),
  complete: true,
  ...overrides,
});

describe("task sidebar pending placement", () => {
  it("holds membership and order when the receipt arrives before the shell", () => {
    const tasks = [task()];
    const threads = [thread()];
    const change = pending();
    expect(taskSidebarDropObserved(change, new Map([[local, 41]]))).toBe(false);
    const visible = applyPendingTaskSidebarDrop(tasks, threads, change);
    expect(visible.tasks[0]?.activeOrderKey).toBe("a1");
    expect(visible.threads[0]?.taskId).toBe("task");
    expect(tasks[0]?.activeOrderKey).toBeNull();
    expect(threads[0]?.taskId).toBeNull();
    expect(taskSidebarDropObserved(change, new Map([[local, 42]]))).toBe(true);
  });

  it("requires the final operation and all owning environments to be observed", () => {
    const change = pending({
      receipts: new Map([
        [local, 42],
        [remote, 9],
      ]),
    });
    expect(taskSidebarDropObserved(change, new Map([[local, 45]]))).toBe(false);
    expect(
      taskSidebarDropObserved(
        change,
        new Map([
          [local, 45],
          [remote, 8],
        ]),
      ),
    ).toBe(false);
    expect(
      taskSidebarDropObserved(
        change,
        new Map([
          [local, 41],
          [remote, 12],
        ]),
      ),
    ).toBe(false);
    const caughtUp = new Map([
      [local, 45],
      [remote, 12],
    ]);
    expect(taskSidebarDropObserved({ ...change, complete: false }, caughtUp)).toBe(false);
    expect(taskSidebarDropObserved(change, caughtUp)).toBe(true);
    expect(
      taskSidebarDropObserved(pending({ complete: false, receipts: new Map() }), new Map()),
    ).toBe(false);
  });

  it("restores the latest canonical membership and order when a failed operation clears pending", () => {
    const tasks = [{ ...task(), activeOrderKey: "a7" }];
    const threads = [{ ...thread(), taskId: TaskId.make("concurrent-task") }];
    const projected = applyPendingTaskSidebarDrop(tasks, threads, pending());
    expect(projected.tasks[0]?.activeOrderKey).toBe("a1");
    expect(projected.threads[0]?.taskId).toBe("task");
    const restored = applyPendingTaskSidebarDrop(tasks, threads, null);
    expect(restored.tasks).toBe(tasks);
    expect(restored.threads).toBe(threads);
    expect(restored.tasks[0]?.activeOrderKey).toBe("a7");
    expect(restored.threads[0]?.taskId).toBe("concurrent-task");
  });

  it("isolates identical IDs across environments and preserves member execution context", () => {
    const tasks = [task(), task(remote)];
    const threads = [thread(), thread(remote)];
    const visible = applyPendingTaskSidebarDrop(tasks, threads, pending());
    expect(visible.tasks[1]).toBe(tasks[1]);
    expect(visible.threads[1]).toBe(threads[1]);
    expect(visible.threads[0]).toEqual({ ...threads[0], taskId: TaskId.make("task") });
    expect(visible.tasks[0]).toEqual({ ...tasks[0], activeOrderKey: "a1" });
  });

  it("projects explicit membership removal without reviving disappeared canonical entities", () => {
    const change = pending({ threadPatches: new Map([["local:thread", { taskId: null }]]) });
    const member = { ...thread(), taskId: TaskId.make("task") };
    expect(applyPendingTaskSidebarDrop([], [member], change).threads[0]?.taskId).toBeNull();
    expect(applyPendingTaskSidebarDrop([], [], change)).toEqual({ tasks: [], threads: [] });
    expect(member.taskId).toBe("task");
  });
});
