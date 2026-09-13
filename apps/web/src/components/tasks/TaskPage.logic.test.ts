import { EnvironmentId, ProjectId, TaskId, type OrchestrationTaskShell } from "@t3tools/contracts";
import { taskWorkbenchRef } from "@t3tools/client-runtime/state/task-workbench";
import { describe, expect, it } from "vite-plus/test";
import { buildTaskWorkbenchContext, taskPageAvailability } from "./TaskPage.logic";

const task: OrchestrationTaskShell = {
  id: TaskId.make("task"),
  name: "Task",
  description: null,
  primaryProjectId: ProjectId.make("project"),
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedAt: null,
  snoozedUntil: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
};
const ready = {
  shellStatus: "live" as const,
  supportsTasks: true,
  task,
  archivedTask: null,
  archiveLoading: false,
  archiveError: null,
  hasPrimaryProject: true,
};

describe("task route availability", () => {
  it("uses the task's stable workbench and follows its primary project without a draft", () => {
    const environmentId = EnvironmentId.make("environment");
    const context = buildTaskWorkbenchContext({ ...task, environmentId });
    const changed = buildTaskWorkbenchContext({
      ...task,
      environmentId,
      primaryProjectId: ProjectId.make("other"),
    });
    expect(context.id).toBe(taskWorkbenchRef({ environmentId, taskId: task.id }).threadId);
    expect(changed.id).toBe(context.id);
    expect(changed.projectId).toBe("other");
    expect(context.messages).toEqual([]);
    expect(context.session).toBeNull();
  });
  it("requires both live shell and completed archive inventory before reporting absence", () => {
    expect(taskPageAvailability({ ...ready, task: null, shellStatus: "synchronizing" })).toBe(
      "loading",
    );
    expect(taskPageAvailability({ ...ready, task: null, archiveLoading: true })).toBe("loading");
    expect(taskPageAvailability({ ...ready, task: null, archiveError: "Offline" })).toBe(
      "archive-error",
    );
    expect(taskPageAvailability({ ...ready, task: null })).toBe("missing");
  });
  it("keeps cached task context and provides archive restoration", () => {
    expect(taskPageAvailability({ ...ready, shellStatus: "cached" })).toBe("cached");
    expect(taskPageAvailability({ ...ready, task: null, shellStatus: "cached" })).toBe(
      "disconnected",
    );
    expect(
      taskPageAvailability({
        ...ready,
        task: null,
        archivedTask: { ...task, archivedAt: task.createdAt },
      }),
    ).toBe("archived");
    expect(taskPageAvailability({ ...ready, hasPrimaryProject: false })).toBe("project-missing");
    expect(taskPageAvailability({ ...ready, supportsTasks: false })).toBe("unsupported");
  });
});
