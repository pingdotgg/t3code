import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { resolveMobileWorkbench } from "./task-workbench";

const environmentId = EnvironmentId.make("environment");
const taskId = TaskId.make("task");
const taskRef = { environmentId, taskId };
const task = { environmentId, id: taskId };
const project = { workspaceRoot: "/primary" };

describe("mobile task workbench", () => {
  it("waits for a known member's task shell instead of exposing standalone tools", () => {
    expect(
      resolveMobileWorkbench({
        threadRef: { environmentId, threadId: ThreadId.make("member") },
        thread: { environmentId, taskId, worktreePath: "/member-checkout" },
        taskRef,
        task: null,
        project: { workspaceRoot: "/member-project" },
      }),
    ).toEqual({ ownerRef: null, workspaceRoot: null, worktreePath: null });
  });

  it("retains the last resolved task tools across a sibling hydration gap", () => {
    const workbench = resolveMobileWorkbench({
      threadRef: null,
      thread: null,
      taskRef,
      task,
      project,
    });
    expect(
      resolveMobileWorkbench({
        threadRef: { environmentId, threadId: ThreadId.make("sibling") },
        thread: { environmentId, taskId, worktreePath: "/sibling-checkout" },
        taskRef,
        task: null,
        project: null,
        previous: { taskRef, workbench },
      }),
    ).toBe(workbench);
    expect(
      resolveMobileWorkbench({
        threadRef: null,
        thread: null,
        taskRef,
        task,
        project: null,
        previous: { taskRef, workbench },
      }),
    ).toBe(workbench);
  });

  it("never retains another task or environment's tools while loading", () => {
    const workbench = resolveMobileWorkbench({
      threadRef: null,
      thread: null,
      taskRef,
      task,
      project,
    });
    for (const nextRef of [
      { environmentId, taskId: TaskId.make("other-task") },
      { environmentId: EnvironmentId.make("other-environment"), taskId },
    ]) {
      expect(
        resolveMobileWorkbench({
          threadRef: null,
          thread: null,
          taskRef: nextRef,
          task: null,
          project: null,
          previous: { taskRef, workbench },
        }),
      ).toEqual({ ownerRef: null, workspaceRoot: null, worktreePath: null });
    }
    const ungroupedRef = { environmentId, threadId: ThreadId.make("ungrouped") };
    expect(
      resolveMobileWorkbench({
        threadRef: ungroupedRef,
        thread: { environmentId, taskId: null, worktreePath: "/member" },
        taskRef: null,
        task: null,
        project,
        previous: { taskRef, workbench },
      }).ownerRef,
    ).toEqual(ungroupedRef);
  });

  it("opens an empty task with no conversation ref and no detail lookup", () => {
    expect(
      resolveMobileWorkbench({ threadRef: null, thread: null, taskRef, task, project }),
    ).toEqual({
      ownerRef: { environmentId, threadId: "task:task" },
      workspaceRoot: "/primary",
      worktreePath: null,
    });
  });

  it("shares tools across siblings without inheriting either member checkout", () => {
    const resolve = (id: string) =>
      resolveMobileWorkbench({
        threadRef: { environmentId, threadId: ThreadId.make(id) },
        thread: { environmentId, taskId, worktreePath: `/worktrees/${id}` },
        threadDetailWorktreePath: `/detail/${id}`,
        taskRef,
        task,
        project,
      });
    expect(resolve("first")).toEqual(resolve("second"));
    expect(resolve("first").worktreePath).toBeNull();
  });

  it("retains owner identity and changes the new terminal root after a primary project edit", () => {
    const before = resolveMobileWorkbench({
      threadRef: null,
      thread: null,
      taskRef,
      task,
      project,
    });
    const after = resolveMobileWorkbench({
      threadRef: null,
      thread: null,
      taskRef,
      task,
      project: { workspaceRoot: "/new-primary" },
    });
    expect(after.ownerRef).toEqual(before.ownerRef);
    expect(after.workspaceRoot).toBe("/new-primary");
  });

  it("keeps ungrouped tools at the real thread checkout", () => {
    const threadRef = { environmentId, threadId: ThreadId.make("thread") };
    expect(
      resolveMobileWorkbench({
        threadRef,
        thread: { environmentId, taskId: null, worktreePath: "/shell" },
        threadDetailWorktreePath: "/detail",
        taskRef: null,
        task: null,
        project,
      }),
    ).toEqual({ ownerRef: threadRef, workspaceRoot: "/primary", worktreePath: "/detail" });
  });

  it("does not resolve a deleted task or a task from another environment", () => {
    expect(
      resolveMobileWorkbench({ threadRef: null, thread: null, taskRef, task: null, project: null })
        .ownerRef,
    ).toBeNull();
    expect(
      resolveMobileWorkbench({
        threadRef: null,
        thread: null,
        taskRef,
        task: { ...task, environmentId: EnvironmentId.make("other") },
        project,
      }).ownerRef,
    ).toBeNull();
  });
});
