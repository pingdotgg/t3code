import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderInstanceId,
  ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  buildScheduledTaskUpdateInput,
  scheduledTaskDefaultModel,
  createDraft,
  editDraft,
  DEFAULT_SCHEDULE,
  hasScheduledTaskDraftChanges,
  scheduleDraftForTask,
  scheduleFromDraft,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
  });

  it("preserves valid fractional-minute schedules through an edit", () => {
    const schedule = { type: "interval" as const, everyMs: 65_000 };
    expect(scheduleFromDraft(scheduleDraftForTask({ schedule }))).toEqual(schedule);
  });
});

describe("hasScheduledTaskDraftChanges", () => {
  it("leaves an untouched form clean and clears changes when edits are reverted", () => {
    const initial = createDraft(null, null);
    const edited = { ...initial, prompt: "Review open issues" };
    expect(hasScheduledTaskDraftChanges(initial, createDraft(null, null))).toBe(false);
    expect(hasScheduledTaskDraftChanges(initial, edited)).toBe(true);
    expect(hasScheduledTaskDraftChanges(initial, { ...edited, prompt: initial.prompt })).toBe(
      false,
    );
  });

  it("keeps invalid, unsaved schedule input dirty", () => {
    const initial = createDraft(null, null);
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        schedule: { ...initial.schedule, weekdays: [] },
      }),
    ).toBe(true);
  });

  it("does not warn after deselecting and reselecting the same weekdays", () => {
    const initial = createDraft(null, null);
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        schedule: { ...initial.schedule, weekdays: [2, 3, 4, 5, 1] },
      }),
    ).toBe(false);
  });

  it("detects changes from the branch and model pickers", () => {
    const initial = createDraft(null, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
    expect(hasScheduledTaskDraftChanges(initial, { ...initial, baseRef: "release" })).toBe(true);
    expect(hasScheduledTaskDraftChanges(initial, { ...initial, startFromOrigin: false })).toBe(
      true,
    );
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        modelSelection: {
          ...initial.modelSelection!,
          options: [
            { id: "fastMode", value: false },
            { id: "effort", value: "high" },
          ],
        },
      }),
    ).toBe(false);
    expect(
      hasScheduledTaskDraftChanges(initial, {
        ...initial,
        modelSelection: {
          ...initial.modelSelection!,
          options: [
            { id: "effort", value: "low" },
            { id: "fastMode", value: false },
          ],
        },
      }),
    ).toBe(true);
  });
});

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it("accepts a selected local time and sorts weekdays", () => {
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, timeOfDay: "18:30", weekdays: [5, 1] }),
    ).toEqual({
      type: "fixed_time",
      timeOfDay: "18:30",
      weekdays: [1, 5],
    });
  });

  it("stores every day without a weekday restriction", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [1, 2, 3, 4, 5, 6, 0] })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
    });
  });

  it("does not add a missing run day when an existing schedule contains duplicates", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [1, 2, 3, 4, 5, 6, 6] })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
      weekdays: [1, 2, 3, 4, 5, 6],
    });
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [0, 1, 2, 3, 4, 5, 6, 6] })).toEqual({
      type: "fixed_time",
      timeOfDay: "09:00",
    });
  });

  it.each([-1, 7, 1.5, NaN])(
    "rejects invalid weekday %s instead of scheduling every day",
    (day) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [0, 1, 2, 3, 4, 5, day] }),
      ).toBeNull();
    },
  );

  it("rejects malformed times and sub-minute intervals", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, timeOfDay: "25:00" })).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "0" }),
    ).toBeNull();
    expect(
      scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes: "15" }),
    ).toEqual({
      type: "interval",
      everyMs: 900_000,
    });
  });

  it.each([
    ["1.5", 90_000],
    ["1000001", 60_000_060_000],
    [String(60_001 / 60_000), 60_001],
    [String(65_000 / 60_000), 65_000],
    [String(123_456 / 60_000), 123_456],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it.each(["NaN", "Infinity", "9007199254740991", "0.5"])(
    "rejects intervals that cannot be written as safe whole milliseconds: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );
});

const legacyTask: ScheduledTask = {
  id: ScheduledTaskId.make("legacy-task"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "release" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

describe("editing scheduled task branch settings", () => {
  it("keeps an omitted origin flag on the local base branch", () => {
    const draft = editDraft(legacyTask);
    expect(draft.baseRef).toBe("release");
    expect(draft.startFromOrigin).toBe(false);
  });

  it.each([true, false])("preserves an explicit origin flag of %s", (startFromOrigin) => {
    const draft = editDraft({
      ...legacyTask,
      workspaceStrategy: { type: "worktree", baseRef: "release", startFromOrigin },
    });
    expect(draft.startFromOrigin).toBe(startFromOrigin);
  });
});

it("continues to default newly created tasks to origin", () => {
  expect(createDraft(null, null).startFromOrigin).toBe(true);
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = scheduledTaskDefaultModel;
  it("uses the environment default with its provider options", () => {
    expect(resolve(config, { id: projectId })).toEqual(environmentSelection);
  });
  it("prefers the project's configured model", () => {
    expect(resolve(config, { id: projectId, defaultModelSelection: projectSelection })).toEqual(
      projectSelection,
    );
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: projectSelection },
            },
          },
        },
        { id: projectId },
      ),
    ).toEqual(projectSelection);
  });
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
  it("does not choose an implicit model on a disabled provider", () => {
    expect(
      resolve(
        {
          ...config,
          providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
        },
        null,
      ),
    ).toBeNull();
  });
});

describe("buildScheduledTaskUpdateInput", () => {
  const projectId = ProjectId.make("project:one");
  const task: ScheduledTask = {
    id: ScheduledTaskId.make("scheduled-task:mobile-fixture"),
    title: "Original title",
    prompt: "Original prompt",
    enabled: true,
    schedule: { type: "interval", everyMs: 15 * 60_000 },
    projectId,
    threadId: null,
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "mobile",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2026-09-02T00:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };

  it("returns null when the draft matches the task it opened with", () => {
    expect(buildScheduledTaskUpdateInput(editDraft(task), task)).toBeNull();
    expect(buildScheduledTaskUpdateInput(createDraft(null, null), task)).toBeNull();
  });

  it("sends only the fields a stale editor changed, preserving concurrent edits", () => {
    // Another client rewrote the prompt and paused the task while this
    // editor was open; the mobile save carries only the rename the user
    // actually made instead of restoring the stale prompt and enabled flag.
    const draft = { ...editDraft(task), title: "Renamed" };
    const live: ScheduledTask = {
      ...task,
      prompt: "Rewritten elsewhere",
      enabled: false,
    };
    expect(buildScheduledTaskUpdateInput(draft, live)).toEqual({
      id: task.id,
      projectId: task.projectId,
      title: "Renamed",
    });
  });

  it("patches the editable runtime mode", () => {
    const draft = { ...editDraft(task), runtimeMode: "auto" as const };
    expect(buildScheduledTaskUpdateInput(draft, task)).toEqual({
      id: task.id,
      projectId: task.projectId,
      runtimeMode: "auto",
    });
  });

  it("detaches the live binding only when the patch itself re-homes the task", () => {
    const other = ProjectId.make("project:other");
    const bound: ScheduledTask = { ...task, threadId: "thread:bound" as ScheduledTask["threadId"] };
    // A real move away from the binding's project must detach it.
    const moving = { ...editDraft(bound), projectId: other };
    expect(buildScheduledTaskUpdateInput(moving, bound)).toEqual({
      id: bound.id,
      projectId: bound.projectId,
      nextProjectId: other,
      threadId: null,
    });
    // A stale save landing where the task already lives keeps a concurrent
    // rebind instead of erasing it.
    const liveMoved: ScheduledTask = { ...bound, projectId: other };
    expect(buildScheduledTaskUpdateInput(moving, liveMoved)).toEqual({
      id: bound.id,
      projectId: other,
      nextProjectId: other,
    });
  });

  it("overlays only the workspace controls the user changed onto the live strategy", () => {
    const draft = { ...editDraft(task), baseRef: "develop" };
    const live: ScheduledTask = {
      ...task,
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
    };
    expect(buildScheduledTaskUpdateInput(draft, live)).toEqual({
      id: task.id,
      projectId: task.projectId,
      workspaceStrategy: { type: "worktree", baseRef: "develop", startFromOrigin: false },
    });
  });
});
