import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  buildScheduledTaskUpdateInput,
  createDraft,
  editDraft,
  scheduledTaskDefaultModel,
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
  });

  it("round-trips dedupe settings and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 3600,
    };
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, dedupe } });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a webhook signature on save without sending a secret", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
    };
    const saved = scheduleFromDraft(
      scheduleDraftForTask({ schedule: { type: "webhook", signature } }),
    );
    expect(saved).toEqual({ type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} });
    expect(saved?.type === "webhook" && saved.signature && "secret" in saved.signature).toBe(false);
  });

  it("round-trips webhook filters and refuses an invalid one", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.label.name", op: "in", value: ["needs review", "agent:fix"] },
    ] as const;
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, filters } });
    // Untouched rows are left out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft(draft)).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(1) })).toMatchObject({
      filters: filters.slice(1),
    });
    expect(
      scheduleFromDraft({ ...draft, filters: [{ id: "f1", path: "", op: "exists", value: "" }] }),
    ).toBeNull();
  });
});

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it.each([
    ["1.5", 90_000],
    ["2,5", 150_000],
    [" 2,5 ", 150_000],
    [String(60_001 / 60_000), 60_001],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it.each(["0,5", "2,5,0", "Infinity", "150119987580", ""])(
    "rejects invalid interval minutes: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );
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
          settings: {
            ...config.settings,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
          },
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

  it("leaves an unchanged webhook trigger out of the patch", () => {
    const webhookTask: ScheduledTask = {
      ...task,
      schedule: {
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
        maxDeliveryAgeMinutes: 30,
      },
    };
    const draft = { ...editDraft(webhookTask), title: "Renamed" };
    expect(buildScheduledTaskUpdateInput(draft, webhookTask)).toEqual({
      id: webhookTask.id,
      projectId: webhookTask.projectId,
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

  it("emits the normalized schedule for a legacy sub-minute interval", () => {
    const legacy: ScheduledTask = {
      ...task,
      schedule: { type: "interval", everyMs: 30_000 },
    };
    // The draft is untouched — editDraft clamped the baseline to "1" — but
    // the stored 30s interval must still be rewritten to the displayed 60s.
    expect(buildScheduledTaskUpdateInput(editDraft(legacy), legacy)).toEqual({
      id: legacy.id,
      projectId: legacy.projectId,
      schedule: { type: "interval", everyMs: 60_000 },
    });
  });

  it("does not overwrite a concurrent fix to a legacy sub-minute interval", () => {
    const legacy: ScheduledTask = {
      ...task,
      schedule: { type: "interval", everyMs: 30_000 },
    };
    // Another client already normalized the schedule — an untouched save
    // leaves their interval alone instead of forcing the editor's 60s.
    const live: ScheduledTask = { ...legacy, schedule: { type: "interval", everyMs: 90_000 } };
    expect(buildScheduledTaskUpdateInput(editDraft(legacy), live)).toBeNull();
  });

  it("sends only the workspace controls the user changed as a sparse patch", () => {
    // Another client flipped startFromOrigin while this editor was open;
    // the save sends just the edited key and the server merges it into the
    // live strategy, so the concurrent toggle survives on both sides.
    const draft = { ...editDraft(task), baseRef: "develop" };
    const live: ScheduledTask = {
      ...task,
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
    };
    expect(buildScheduledTaskUpdateInput(draft, live)).toEqual({
      id: task.id,
      projectId: task.projectId,
      workspaceStrategyPatch: { baseRef: "develop" },
    });
  });
});

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});
