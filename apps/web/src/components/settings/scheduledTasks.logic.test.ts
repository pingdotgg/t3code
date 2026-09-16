import { ProviderInstanceId } from "@t3tools/contracts";
import type { ModelSelection, ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildScheduledTaskUpdateInput,
  moveDetachesThreadBinding,
  scheduleFromDraft,
  taskToDraft,
  workspaceStrategyFromDraft,
  workspaceStrategyReady,
} from "./scheduledTasks.logic";

const model: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};

const task: ScheduledTask = {
  id: "scheduled-task:fixture" as ScheduledTask["id"],
  title: "Original title",
  prompt: "Original prompt",
  enabled: true,
  schedule: { type: "interval", everyMs: 15 * 60_000 },
  projectId: "project:one" as ScheduledTask["projectId"],
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
  modelSelection: model,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  nextRunAt: "2026-09-02T00:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const buildPatch = (
  draft: ReturnType<typeof taskToDraft>,
  base: ScheduledTask = task,
  baseline: ReturnType<typeof taskToDraft> = taskToDraft(base),
) =>
  buildScheduledTaskUpdateInput(
    draft,
    baseline,
    base,
    draft.baseModelSelection ?? model,
    workspaceStrategyFromDraft(draft),
  );

describe("buildScheduledTaskUpdateInput", () => {
  it("returns null when the draft matches the task", () => {
    expect(buildPatch(taskToDraft(task))).toBeNull();
  });

  it("sends only the edited fields plus the scoped identity", () => {
    const draft = { ...taskToDraft(task), title: "Renamed" };
    expect(buildPatch(draft)).toEqual({
      id: task.id,
      projectId: task.projectId,
      title: "Renamed",
    });
  });

  it("keeps disjoint edits disjoint so concurrent saves merge", () => {
    const titlePatch = buildPatch({ ...taskToDraft(task), title: "A" });
    const promptPatch = buildPatch({ ...taskToDraft(task), prompt: "B" });
    expect(titlePatch).toMatchObject({ title: "A" });
    expect(titlePatch).not.toHaveProperty("prompt");
    expect(promptPatch).toMatchObject({ prompt: "B" });
    expect(promptPatch).not.toHaveProperty("title");
  });

  it("omits a schedule that is semantically identical", () => {
    const fixed: ScheduledTask = {
      ...task,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    };
    // The draft round-trips an all-days mask to an omitted one — same schedule.
    expect(buildPatch(taskToDraft(fixed), fixed)).toBeNull();
  });

  it("sends the schedule when it materially changed", () => {
    const draft = {
      ...taskToDraft(task),
      scheduleMode: "interval" as const,
      intervalMinutes: "30",
    };
    expect(buildPatch(draft)).toMatchObject({
      schedule: { type: "interval", everyMs: 30 * 60_000 },
    });
  });

  it("sends enabled, thread, workspace, model, and project moves when changed", () => {
    const bound: ScheduledTask = { ...task, threadId: "thread:1" as ScheduledTask["threadId"] };
    const baseline = taskToDraft(bound);
    const draft = {
      ...baseline,
      enabled: false,
      threadId: "",
      workspaceMode: "root" as const,
      modelKey: "codex:gpt-5.2-codex",
      projectId: "project:two",
    };
    expect(
      buildScheduledTaskUpdateInput(
        draft,
        baseline,
        bound,
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.2-codex" },
        { type: "root" },
      ),
    ).toEqual({
      id: bound.id,
      projectId: bound.projectId,
      enabled: false,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.2-codex" },
      nextProjectId: "project:two",
    });
  });

  it("never includes schedule fields the draft cannot express", () => {
    const draft = taskToDraft(task);
    expect(scheduleFromDraft(draft)).toEqual(task.schedule);
  });

  it("does not revert changes another client committed while the editor was open", () => {
    const opened = taskToDraft(task);
    // Another client changed the prompt, paused the task, and moved it to a
    // different project after the editor opened — the draft still holds the
    // opening values for every control except the one the user touched.
    const live: ScheduledTask = {
      ...task,
      prompt: "Rewritten elsewhere",
      enabled: false,
      projectId: "project:two" as ScheduledTask["projectId"],
    };
    const draft = { ...opened, title: "My rename" };
    const patch = buildScheduledTaskUpdateInput(
      draft,
      opened,
      live,
      draft.baseModelSelection ?? model,
      workspaceStrategyFromDraft(draft),
    );
    // Only the user's title edit is sent; the concurrent prompt, pause, and
    // project move survive. The patch scopes the lookup to where the task
    // lives now.
    expect(patch).toEqual({
      id: task.id,
      projectId: live.projectId,
      title: "My rename",
    });
  });

  it("preserves workspace fields the dialog cannot express when the control is dirty", () => {
    // A stored worktree strategy can carry fields the editor has no control
    // for (branch, startFromOrigin). Editing the base ref must patch the
    // field the user changed, not rebuild the strategy from defaults.
    const rich: ScheduledTask = {
      ...task,
      workspaceStrategy: {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: false,
        branch: "release/1.2",
      },
    };
    const baseline = taskToDraft(rich);
    const draft = { ...baseline, baseRef: "develop" };
    expect(
      buildScheduledTaskUpdateInput(
        draft,
        baseline,
        rich,
        model,
        workspaceStrategyFromDraft(draft),
      ),
    ).toEqual({
      id: rich.id,
      projectId: rich.projectId,
      workspaceStrategy: {
        type: "worktree",
        baseRef: "develop",
        startFromOrigin: false,
        branch: "release/1.2",
      },
    });
  });

  it("treats draft round-trip conversions as unchanged when the control was untouched", () => {
    // taskToDraft cannot express every persisted shape: a 90-second interval
    // rounds to "2" minutes and worktree.startFromOrigin is dropped. An
    // untouched editor must not turn that normalization into a patch.
    const lossy: ScheduledTask = {
      ...task,
      schedule: { type: "interval", everyMs: 90_000 },
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
    };
    const opened = taskToDraft(lossy);
    expect(buildPatch(opened, lossy, opened)).toBeNull();
    // And a save that only renames still sends no schedule/workspace fields.
    const renamed = { ...opened, title: "Renamed" };
    expect(buildPatch(renamed, lossy, opened)).toEqual({
      id: lossy.id,
      projectId: lossy.projectId,
      title: "Renamed",
    });
  });
});

describe("workspaceStrategyReady", () => {
  it("rejects a blank checkout path that would fail contract validation", () => {
    const draft = taskToDraft(task);
    const blank = {
      ...draft,
      workspaceMode: "existing_worktree" as const,
      existingWorktreePath: "   ",
    };
    expect(workspaceStrategyReady(blank)).toBe(false);
    expect(workspaceStrategyReady({ ...blank, existingWorktreePath: " /repo/wt " })).toBe(true);
    expect(workspaceStrategyReady({ ...draft, workspaceMode: "root" })).toBe(true);
    expect(workspaceStrategyReady({ ...draft, workspaceMode: "worktree" })).toBe(true);
  });
});

describe("moveDetachesThreadBinding", () => {
  const bound: ScheduledTask = {
    ...task,
    threadId: "thread:bound" as ScheduledTask["threadId"],
  };

  it("unbinds in the same patch when a bound task moves projects", () => {
    const opened = taskToDraft(bound);
    const moved = { ...opened, projectId: "project:two" };
    expect(moveDetachesThreadBinding(moved, opened)).toBe(true);
    const patch = buildPatch(moved, bound, opened);
    expect(patch).toEqual({
      id: bound.id,
      projectId: bound.projectId,
      nextProjectId: "project:two",
      threadId: null,
    });
  });

  it("keeps the binding when the project is unchanged", () => {
    const opened = taskToDraft(bound);
    const renamed = { ...opened, title: "Renamed" };
    expect(moveDetachesThreadBinding(renamed, opened)).toBe(false);
    const patch = buildPatch(renamed, bound, opened);
    expect(patch).toEqual({
      id: bound.id,
      projectId: bound.projectId,
      title: "Renamed",
    });
    expect(patch).not.toHaveProperty("threadId");
  });

  it("never detaches for an unbound task", () => {
    const opened = taskToDraft(task);
    const moved = { ...opened, projectId: "project:two" };
    expect(moveDetachesThreadBinding(moved, opened)).toBe(false);
    const patch = buildPatch(moved, task, opened);
    expect(patch).not.toHaveProperty("threadId");
  });
});
