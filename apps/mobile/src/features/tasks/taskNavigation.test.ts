import { EnvironmentId, ProjectId, TaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveTaskNavigation } from "./taskNavigation";

const task = {
  environmentId: EnvironmentId.make("remote"),
  id: TaskId.make("task"),
  primaryProjectId: ProjectId.make("primary"),
  archivedAt: null,
};
const base = { task, usesSplitView: true, currentRouteName: "Thread" };

describe("native task action destinations", () => {
  it.each([
    [false, "Home", "push"],
    [false, "Thread", "push"],
    [false, "Task", "push"],
    [true, "Home", "push"],
    [true, "Thread", "replace"],
    [true, "ThreadFiles", "replace"],
    [true, "Task", "set-params"],
  ] as const)("split view %s from %s uses %s", (usesSplitView, currentRouteName, action) => {
    for (const intent of ["open", "rename"] as const)
      expect(resolveTaskNavigation({ ...base, usesSplitView, currentRouteName, intent })).toEqual({
        action,
        screen: "Task",
        params: {
          environmentId: "remote",
          taskId: "task",
          focusName: intent === "rename",
        },
      });
  });

  it("new threads always use the selected task's primary project and environment", () => {
    for (const usesSplitView of [true, false]) {
      for (const currentRouteName of ["Home", "Task", "Thread"]) {
        for (const environmentId of [task.environmentId, EnvironmentId.make("local")]) {
          expect(
            resolveTaskNavigation({
              task: { ...task, environmentId },
              intent: "new-thread",
              usesSplitView,
              currentRouteName,
            }),
          ).toEqual({
            action: "navigate",
            screen: "NewTaskSheet",
            params: {
              screen: "NewTaskDraft",
              params: { environmentId, projectId: "primary", taskId: "task" },
            },
          });
        }
      }
    }
  });

  it("archived tasks permit opening but neither drafting nor renaming", () => {
    const archived = { ...task, archivedAt: "2026-09-13T00:00:00.000Z" };
    for (const intent of ["rename", "new-thread"] as const)
      expect(resolveTaskNavigation({ ...base, task: archived, intent })).toBeNull();
    expect(resolveTaskNavigation({ ...base, task: archived, intent: "open" })).toMatchObject({
      screen: "Task",
      params: { focusName: false },
    });
  });
});
