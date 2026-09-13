import { EnvironmentId, TaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "../environment/scoped.ts";
import { taskWorkbenchRef, workbenchRefFor } from "./taskWorkbench.ts";

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
