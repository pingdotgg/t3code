import { ProviderInstanceId } from "@t3tools/contracts";
import type { ModelSelection, ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskToDraft } from "./scheduledTasksSettings.logic";
import {
  buildScheduledTaskUpdateInput,
  moveDetachesThreadBinding,
  scheduleFromDraft,
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

  it("keeps fractional interval minutes instead of truncating them", () => {
    const fractional: ScheduledTask = {
      ...task,
      schedule: { type: "interval", everyMs: 90_000 },
    };
    const baseline = taskToDraft(fractional);
    // "1.5" -> "1.9" must dirty the schedule even though both truncate to 1.
    expect(buildPatch({ ...baseline, intervalMinutes: "1.9" }, fractional)).toMatchObject({
      schedule: { type: "interval", everyMs: 114_000 },
    });
    // "1.5" -> "2.5" must save the value the editor displays, not 120s.
    expect(buildPatch({ ...baseline, intervalMinutes: "2.5" }, fractional)).toMatchObject({
      schedule: { type: "interval", everyMs: 150_000 },
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

  it("overlays only the workspace controls the user changed onto the live strategy", () => {
    // The editor opened with startFromOrigin: true; another client committed
    // startFromOrigin: false while it was open. A save that changes only the
    // base ref must keep the live toggle instead of reverting it.
    const opened = taskToDraft(task);
    const live: ScheduledTask = {
      ...task,
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
    };
    const draft = { ...opened, baseRef: "develop" };
    expect(
      buildScheduledTaskUpdateInput(draft, opened, live, model, workspaceStrategyFromDraft(draft)),
    ).toEqual({
      id: task.id,
      projectId: task.projectId,
      workspaceStrategy: { type: "worktree", baseRef: "develop", startFromOrigin: false },
    });
  });

  it("drops a stale workspace control edit when a concurrent save switched the workspace kind", () => {
    // The live task moved to root while the editor was open; a stale base-ref
    // edit cannot be expressed on it and must not resurrect a worktree
    // strategy over the concurrent choice.
    const opened = taskToDraft(task);
    const live: ScheduledTask = { ...task, workspaceStrategy: { type: "root" } };
    const draft = { ...opened, baseRef: "develop" };
    expect(
      buildScheduledTaskUpdateInput(draft, opened, live, model, workspaceStrategyFromDraft(draft)),
    ).toBeNull();
  });

  it("preserves workspace fields the dialog cannot express when the control is dirty", () => {
    // A stored worktree strategy can carry fields the editor has no control
    // for (`branch`). Editing the base ref must patch the field the user
    // changed while carrying the unexpressible fields from the live task.
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
    // stringifies to "1.5" minutes and parseInt rounds it back down. An
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

  it("keeps a binding committed by a concurrent move-and-rebind", () => {
    // The editor opened while the task was bound to a thread in project one.
    // Another client then moved the task to project two and bound a thread
    // there. A stale save that "moves" the draft to project two must not
    // delete that newer binding — the patch itself re-homes nothing.
    const opened = taskToDraft(bound);
    const live: ScheduledTask = {
      ...bound,
      projectId: "project:two" as ScheduledTask["projectId"],
      threadId: "thread:rebound" as ScheduledTask["threadId"],
    };
    const staleMove = { ...opened, projectId: "project:two" };
    const patch = buildScheduledTaskUpdateInput(
      staleMove,
      opened,
      live,
      model,
      workspaceStrategyFromDraft(staleMove),
    );
    expect(patch).not.toHaveProperty("threadId");
    // And a stale save that changes nothing about the project keeps it too.
    const staleEdit = { ...opened, title: "Renamed" };
    const editPatch = buildScheduledTaskUpdateInput(
      staleEdit,
      opened,
      live,
      model,
      workspaceStrategyFromDraft(staleEdit),
    );
    expect(editPatch).toEqual({
      id: live.id,
      projectId: live.projectId,
      title: "Renamed",
    });
    expect(editPatch).not.toHaveProperty("threadId");
  });

  it("preserves a live binding when an unbound draft moves to its project", () => {
    // The draft never saw a binding. Another client moved the task to
    // project two and bound a thread there — the binding is valid in the
    // destination, so the stale move must not erase it.
    const opened = taskToDraft(task);
    const live: ScheduledTask = {
      ...task,
      projectId: "project:two" as ScheduledTask["projectId"],
      threadId: "thread:bound-elsewhere" as ScheduledTask["threadId"],
    };
    const staleMove = { ...opened, projectId: "project:two" };
    const patch = buildScheduledTaskUpdateInput(
      staleMove,
      opened,
      live,
      model,
      workspaceStrategyFromDraft(staleMove),
    );
    expect(patch).not.toHaveProperty("threadId");
  });

  it("detaches a live binding anchored in a different project than the destination", () => {
    // Another client moved the task to project three and bound W there.
    // This editor's move to project two is a real re-home — W is invalid in
    // project two and the server would reject the merged pair, so the patch
    // detaches it explicitly.
    const opened = taskToDraft(bound);
    const live: ScheduledTask = {
      ...bound,
      projectId: "project:three" as ScheduledTask["projectId"],
      threadId: "thread:elsewhere" as ScheduledTask["threadId"],
    };
    const moved = { ...opened, projectId: "project:two" };
    const patch = buildScheduledTaskUpdateInput(
      moved,
      opened,
      live,
      model,
      workspaceStrategyFromDraft(moved),
    );
    expect(patch).toEqual({
      id: live.id,
      projectId: live.projectId,
      nextProjectId: "project:two",
      threadId: null,
    });
  });

  it("emits no project or thread fields when the draft moves back to its origin", () => {
    const opened = taskToDraft(bound);
    const movedBack = { ...opened, projectId: bound.projectId };
    const patch = buildScheduledTaskUpdateInput(
      movedBack,
      opened,
      bound,
      model,
      workspaceStrategyFromDraft(movedBack),
    );
    expect(patch).toBeNull();
  });

  it("does not detach when a retry moves an already-unbound task", () => {
    // A committed move left the task in project two unbound. A follow-up
    // move back to project one re-homes it without any binding to drop.
    const live: ScheduledTask = {
      ...task,
      projectId: "project:two" as ScheduledTask["projectId"],
    };
    const reopened = taskToDraft(live);
    const movedBack = { ...reopened, projectId: "project:one" };
    const patch = buildScheduledTaskUpdateInput(
      movedBack,
      reopened,
      live,
      model,
      workspaceStrategyFromDraft(movedBack),
    );
    expect(patch).toEqual({
      id: live.id,
      projectId: live.projectId,
      nextProjectId: "project:one",
    });
    expect(patch).not.toHaveProperty("threadId");
  });
});
