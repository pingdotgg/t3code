import { ProjectId, TaskId, type OrchestrationTaskShell } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createTaskPageDraftPreparation,
  taskPageAvailability,
  taskPageBackgroundDraftTransition,
} from "./TaskPage.logic";

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

describe("task page draft preparation", () => {
  it("shares preparation across effect replay and prepares afresh for a project or page generation change", async () => {
    const prepare = createTaskPageDraftPreparation<string>();
    let resolve!: (draft: string) => void;
    const create = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const first = prepare("environment/task/project/0", create);
    expect(prepare("environment/task/project/0", create)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    resolve("draft");
    expect(await first).toBe("draft");
    const second = prepare("environment/task/other-project/0", async () => "new-project-draft");
    expect(await second).toBe("new-project-draft");
    expect(await prepare("environment/task/other-project/1", async () => "after-promotion")).toBe(
      "after-promotion",
    );
  });
});

describe("task page submission transitions", () => {
  it("retains foreground and pending background composers, and only replaces completed background work", () => {
    expect(
      taskPageBackgroundDraftTransition({
        wasBackground: false,
        backgroundPending: false,
        threadExists: true,
      }),
    ).toBe("keep");
    expect(
      taskPageBackgroundDraftTransition({
        wasBackground: true,
        backgroundPending: true,
        threadExists: true,
      }),
    ).toBe("keep");
    expect(
      taskPageBackgroundDraftTransition({
        wasBackground: true,
        backgroundPending: false,
        threadExists: true,
      }),
    ).toBe("next-draft");
    expect(
      taskPageBackgroundDraftTransition({
        wasBackground: true,
        backgroundPending: false,
        threadExists: false,
      }),
    ).toBe("failed");
  });
});
