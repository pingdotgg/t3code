import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type McpGatewayProfile,
  type ScheduledTask,
  type ServerConfig,
  type ServerProvider,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import {
  createDraft,
  scheduledTaskDefaultModel,
  DEFAULT_SCHEDULE,
  editDraft,
  hasScheduledTaskDraftChanges,
  moveDraftOffAgent,
  moveDraftToAgent,
  schedulableAgentProfiles,
  scheduledTaskDraftRouting,
  scheduleDraftForTask,
  scheduleFromDraft,
  unbindDraftFromThread,
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
    expect(saved).toEqual({ type: "webhook", signature, dedupe: {} });
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
  it.each([
    ["0 7 * * 1-5", "weekdays"],
    ["30 * * * *", "hourly"],
    ["15 9 * * 3", "weekly"],
    ["*/5 1-3 * * *", "custom"],
  ])("reopens cron %s on its %s preset and saves it unchanged", (expression, preset) => {
    const schedule = { type: "cron" as const, expression, timezone: "Europe/London" };
    const draft = scheduleDraftForTask({ schedule });
    expect(draft).toMatchObject({ mode: "cron", repeat: { preset }, timezone: "Europe/London" });
    expect(scheduleFromDraft(draft)).toEqual(schedule);
  });

  it("saves an edited cron preset and refuses a malformed one", () => {
    const draft = scheduleDraftForTask({
      schedule: { type: "cron", expression: "0 7 * * *", timezone: "UTC" },
    });
    expect(
      scheduleFromDraft({ ...draft, repeat: { ...draft.repeat, preset: "weekly", weekday: 2 } }),
    ).toEqual({ type: "cron", expression: "0 7 * * 2", timezone: "UTC" });
    const taskDraft = editDraft(
      task({ schedule: { type: "cron", expression: "0 7 * * *", timezone: "UTC" } }),
    );
    expect(
      hasScheduledTaskDraftChanges(taskDraft, {
        ...taskDraft,
        schedule: { ...taskDraft.schedule, timezone: "Europe/Paris" },
      }),
    ).toBe(true);
    expect(
      scheduleFromDraft({ ...draft, repeat: { ...draft.repeat, preset: "hourly", time: "00:75" } }),
    ).toBeNull();
    expect(
      scheduleFromDraft({
        ...draft,
        repeat: { ...draft.repeat, preset: "custom", expression: "0 7" },
      }),
    ).toBeNull();
  });

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

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});

const environmentId = EnvironmentId.make("environment");
const codex = ProviderInstanceId.make("codex");
const providers = [
  {
    instanceId: codex,
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "agent-model", name: "Agent", isCustom: false, capabilities: null }],
  },
] as unknown as ReadonlyArray<ServerProvider>;
const profile = (fields: Partial<McpGatewayProfile>) =>
  ({
    profileId: "reviewer",
    name: "Reviewer",
    runtimeMode: "approval-required",
    interactionMode: "plan",
    modelSelection: { instanceId: codex, model: "agent-model" },
    ...fields,
  }) as McpGatewayProfile;
const profiles = [
  profile({}),
  profile({ profileId: "reader", runtimeMode: "read-only" }),
  profile({ profileId: "elsewhere", environmentIds: [EnvironmentId.make("other")] }),
];
const taskModel = { instanceId: codex, model: "task-model" };
const task = (fields: Partial<ScheduledTask>) =>
  ({
    id: "task",
    title: "Task",
    prompt: "Do it",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: taskModel,
    runtimeMode: "full-access",
    interactionMode: "default",
    ...fields,
  }) as ScheduledTask;
const context = { profiles, providers, offersThreadModes: true };

describe("scheduled task agent routing", () => {
  it("offers only agents that can run tasks on this environment", () => {
    expect(schedulableAgentProfiles(profiles, environmentId).map((p) => p.profileId)).toEqual([
      "reviewer",
    ]);
  });

  it("routes a new agent task through the agent's model and modes", () => {
    const draft = moveDraftToAgent(editDraft(task({})), "reviewer");
    expect(scheduledTaskDraftRouting(draft, context)).toEqual({
      profileId: "reviewer",
      threadId: null,
      modelSelection: { instanceId: codex, model: "agent-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(scheduledTaskDraftRouting(moveDraftToAgent(draft, "reader"), context)).toBe(
      "Agent Reviewer is read-only and cannot run scheduled tasks.",
    );
  });

  it("keeps an agent task's own thread and stored model until the agent changes", () => {
    const own = ThreadId.make("own");
    const draft = editDraft(
      task({ profileId: "reviewer", threadId: own, runtimeMode: "auto-accept-edits" }),
    );
    expect(draft.profileId).toBe("reviewer");
    expect(scheduledTaskDraftRouting(unbindDraftFromThread(draft), context)).toMatchObject({
      threadId: null,
    });
    expect(scheduledTaskDraftRouting(draft, context)).toEqual({
      profileId: "reviewer",
      threadId: own,
      modelSelection: taskModel,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
    });
    const other = moveDraftToAgent(draft, "missing");
    expect(hasScheduledTaskDraftChanges(draft, other)).toBe(true);
    expect(other.threadId).toBeNull();
    expect(scheduledTaskDraftRouting(other, context)).toBe("Agent missing was not found.");
    expect(moveDraftToAgent(other, "reviewer").threadId).toBe(own);
  });

  it("clears the agent only on a task that had one", () => {
    const agentTask = editDraft(
      task({ profileId: "reviewer", threadId: ThreadId.make("own"), interactionMode: "plan" }),
    );
    expect(
      scheduledTaskDraftRouting(
        { ...moveDraftOffAgent(agentTask), threadMode: "new_thread" },
        context,
      ),
    ).toEqual({
      profileId: null,
      threadId: null,
      threadMode: "new_thread",
      modelSelection: taskModel,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const threadTask = scheduledTaskDraftRouting(
      editDraft(task({ threadId: ThreadId.make("bound"), interactionMode: "plan" })),
      { ...context, offersThreadModes: false },
    );
    expect(threadTask).toEqual({
      threadId: ThreadId.make("bound"),
      modelSelection: taskModel,
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  });
});

describe("scheduled task worktree base", () => {
  const rootTask = {
    id: ScheduledTaskId.make("task"),
    title: "Review issues",
    prompt: "Review open issues",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "mobile",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  } satisfies ScheduledTask;

  it("leaves the base automatic for new tasks and tasks without a worktree", () => {
    expect(createDraft(ProjectId.make("project"), null).baseRef).toBe("");
    expect(editDraft(rootTask).baseRef).toBe("");
    expect(
      editDraft({ ...rootTask, workspaceStrategy: { type: "worktree", baseRef: "release" } })
        .baseRef,
    ).toBe("release");
  });
});
