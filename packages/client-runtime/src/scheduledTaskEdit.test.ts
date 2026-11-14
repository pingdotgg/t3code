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
