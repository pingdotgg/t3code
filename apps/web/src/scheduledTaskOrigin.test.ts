import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveScheduledThreadOrigin } from "./scheduledTaskOrigin";

const task = {
  id: ScheduledTaskId.make("task-1"),
  title: "Morning triage",
  prompt: "Check the repo",
  enabled: true,
  cadence: "daily",
  target: {
    type: "project",
    projectId: ProjectId.make("project-1"),
    workspace: { mode: "local", worktreePath: null },
  },
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-07-02T10:00:00.000Z",
  updatedAt: "2026-07-02T10:00:00.000Z",
  lastStartedAt: "2026-07-02T10:05:00.000Z",
  lastFinishedAt: "2026-07-02T10:06:00.000Z",
  lastStatus: "succeeded",
  lastError: null,
  lastThreadId: ThreadId.make("thread-1"),
  runState: "scheduled",
  nextRunAt: "2026-07-03T10:06:00.000Z",
} satisfies ScheduledTaskSnapshot;

describe("resolveScheduledThreadOrigin", () => {
  it("returns an existing scheduled-task origin", () => {
    expect(
      resolveScheduledThreadOrigin({
        thread: {
          id: ThreadId.make("thread-1"),
          origin: {
            type: "scheduled-task",
            scheduledTaskId: ScheduledTaskId.make("task-existing"),
            scheduledTaskTitle: "Existing task",
          },
        },
        scheduledTasks: [task],
      }),
    ).toEqual({
      type: "scheduled-task",
      scheduledTaskId: ScheduledTaskId.make("task-existing"),
      scheduledTaskTitle: "Existing task",
    });
  });

  it("falls back to the scheduled task whose last run created the thread", () => {
    expect(
      resolveScheduledThreadOrigin({
        thread: { id: ThreadId.make("thread-1") },
        scheduledTasks: [task],
      }),
    ).toEqual({
      type: "scheduled-task",
      scheduledTaskId: ScheduledTaskId.make("task-1"),
      scheduledTaskTitle: "Morning triage",
    });
  });
});
