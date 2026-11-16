import {
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskEditPatch } from "./scheduledTaskEdit.ts";

const opened: ScheduledTask = {
  id: ScheduledTaskId.make("scheduled-task:edit"),
  title: "Nightly",
  prompt: "Original prompt",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project:edit"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// What the editors submit: every field, rebuilt from the form opened on `opened`.
const editorSave = (overrides: Partial<ScheduledTaskUpsertInput>): ScheduledTaskUpsertInput => ({
  id: opened.id,
  requireExisting: true,
  title: opened.title,
  prompt: opened.prompt,
  enabled: opened.enabled,
  schedule: { everyMs: 3_600_000, type: "interval" },
  projectId: opened.projectId,
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { startFromOrigin: true, type: "worktree", baseRef: "main" },
  modelSelection: opened.modelSelection,
  runtimeMode: opened.runtimeMode,
  interactionMode: opened.interactionMode,
  creationSource: "web",
  ...overrides,
});

describe("scheduledTaskEditPatch", () => {
  it("sends only what the editor changed, so a concurrent prompt edit survives a rename", () => {
    expect(scheduledTaskEditPatch(opened, editorSave({ title: "Renamed" }))).toEqual({
      id: opened.id,
      projectId: opened.projectId,
      title: "Renamed",
    });
  });

  it("leaves an untouched webhook schedule out, so a concurrent signing change survives", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex",
      prefix: "sha256=",
    } as const;
    const hook: ScheduledTask = {
      ...opened,
      schedule: {
        type: "webhook",
        signature,
        filters: [{ path: "headers.x-github-event", op: "equals", value: "push" }],
      },
    };
    const save = editorSave({
      title: "Renamed",
      schedule: { type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} },
    });
    expect(scheduledTaskEditPatch(hook, save)).toEqual({
      id: opened.id,
      projectId: opened.projectId,
      title: "Renamed",
    });
  });

  it.each([
    [
      { type: "fixed_time", timeOfDay: "9:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      { type: "fixed_time", timeOfDay: "09:00" },
    ],
    [
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5] },
    ],
    [
      { type: "once", runAt: "2026-12-01T09:00:00.000Z" },
      { type: "once", runAt: "2026-12-01T10:00:00+01:00" },
    ],
  ] as const)("leaves an untouched schedule out when it is spelled differently", (stored, sent) => {
    expect(
      scheduledTaskEditPatch(
        { ...opened, schedule: stored },
        editorSave({ title: "Renamed", schedule: sent }),
      ),
    ).toEqual({ id: opened.id, projectId: opened.projectId, title: "Renamed" });
  });

  it("leaves an untouched workspace out, so a concurrent base ref change survives", () => {
    const task: ScheduledTask = {
      ...opened,
      workspaceStrategy: { type: "worktree", baseRef: "main", branch: "kept" },
    };
    const save = editorSave({
      title: "Renamed",
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
    });
    expect(scheduledTaskEditPatch(task, save)).toEqual({
      id: opened.id,
      projectId: opened.projectId,
      title: "Renamed",
    });
  });

  it("sends a project change as a move from the opened project", () => {
    expect(
      scheduledTaskEditPatch(opened, editorSave({ projectId: ProjectId.make("project:other") })),
    ).toEqual({
      id: opened.id,
      projectId: opened.projectId,
      nextProjectId: "project:other",
    });
  });
});
