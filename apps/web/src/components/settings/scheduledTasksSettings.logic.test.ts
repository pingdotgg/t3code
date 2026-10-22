import {
  EnvironmentId,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type ServerConfig,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { decideDaybreakModelChange } from "@t3tools/client-runtime/model-traits";
import { getCustomModelOptionsByInstance } from "../../modelSelection";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import {
  scheduledTaskDefaultModel,
  scheduledTaskModelDescriptors,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  taskToDraft,
} from "./scheduledTasksSettings.logic";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  };
}

const sameIdElsewhere = member("first", serverId);
const groups = [group("t3code", [first, second, third]), group("other", [other, sameIdElsewhere])];
const tasks = [first, second, third, other, sameIdElsewhere].map((project, index) => ({
  id: `task-${index}`,
  environmentId: project.environmentId,
  projectId: project.id,
}));

describe("scheduled task settings scope", () => {
  it.each<{ search: SettingsScopeSearch; expected: string[] }>([
    { search: {}, expected: ["task-0", "task-1", "task-2", "task-3", "task-4"] },
    { search: { machine: laptopId }, expected: ["task-0", "task-1"] },
    { search: { project: "t3code" }, expected: ["task-0", "task-1", "task-2"] },
    { search: { project: "t3code", machine: serverId }, expected: ["task-2"] },
    { search: { project: "t3code", checkout: second.physicalProjectKey }, expected: ["task-1"] },
    { search: { project: "missing" }, expected: [] },
    { search: { machine: "removed" }, expected: [] },
    { search: { project: "t3code", checkout: "removed" }, expected: [] },
    { search: { project: "other", machine: laptopId }, expected: [] },
  ])("lists only matching tasks for $search", ({ search, expected }) => {
    const scope = resolveSettingsScope(search, groups, environments);
    expect(
      tasks
        .filter((task) => matchesScheduledTaskScope(scope, task.environmentId, task.projectId))
        .map((task) => task.id),
    ).toEqual(expected);
  });

  it("keeps tasks with removed projects manageable at environment scope", () => {
    const removedProject = ProjectId.make("removed");
    expect(
      matchesScheduledTaskScope(
        resolveSettingsScope({}, groups, environments),
        laptopId,
        removedProject,
      ),
    ).toBe(true);
    expect(
      matchesScheduledTaskScope(
        resolveSettingsScope({ project: "t3code" }, groups, environments),
        laptopId,
        removedProject,
      ),
    ).toBe(false);
  });
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
    const draft = taskToDraft(legacyTask);
    expect(draft.baseRef).toBe("release");
    expect(draft.startFromOrigin).toBe(false);
  });
});

describe("webhook scheduled tasks", () => {
  const signature = { header: "x-signature", encoding: "base64", prefix: "" } as const;
  const webhookTask: ScheduledTask = {
    ...legacyTask,
    schedule: { type: "webhook", signature },
    webhook: { path: "/api/hooks/legacy-task/token", url: null, hasSecret: true },
  };

  it("round-trips dedupe settings, clears them, and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 10,
    };
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, dedupe },
    });
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
    expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds: "" })).toMatchObject({
      dedupe: { replayKey: dedupe.replayKey, coalesceKey: dedupe.coalesceKey },
    });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a stored secret when the secret field is left blank", () => {
    const draft = taskToDraft(webhookTask);
    expect(draft.scheduleMode).toBe("webhook");
    expect(draft.signatureSecret).toBe("");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature,
      maxDeliveryAgeMinutes: null,
      dedupe: {},
    });
    expect(scheduleFromDraft({ ...draft, signatureSecret: " new " })).toEqual({
      type: "webhook",
      signature: { ...signature, secret: "new" },
      maxDeliveryAgeMinutes: null,
      dedupe: {},
    });
  });

  it("round-trips the max age, treats blank as no limit, and rejects an invalid limit", () => {
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: 90 },
    });
    expect(draft.maxDeliveryAgeMinutes).toBe("90");
    expect(scheduleFromDraft(draft)).toMatchObject({ maxDeliveryAgeMinutes: 90 });
    for (const blank of ["", "  "]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: blank })).toMatchObject({
        maxDeliveryAgeMinutes: null,
        dedupe: {},
      });
    }
    for (const invalid of ["0", "-5", "1.5", "abc", "1441"]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: invalid })).toBeNull();
    }
  });

  it("sends filters only when the form changed them", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "in", value: ["opened", "reopened"] },
    ] as const;
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature, filters },
    });
    expect(draft.filters.map((filter) => filter.op)).toEqual(["equals", "in"]);
    // A title-only save leaves the key out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft({ ...draft, title: "Renamed" })).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(0, 1) })).toMatchObject({
      filters: filters.slice(0, 1),
    });
    // Removing every row is a change, so it clears the stored filters.
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(
      scheduleFromDraft({
        ...draft,
        filters: [{ id: "f1", path: "body.action", op: "in", value: " , " }],
      }),
    ).toBeNull();
  });
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
  const resolve = (
    value: ServerConfig,
    project: { id: typeof projectId; defaultModelSelection?: typeof projectSelection } | null,
  ) =>
    scheduledTaskDefaultModel(
      value.settings,
      project,
      deriveProviderInstanceEntries(value.providers),
    );
  it("falls back to the destination project default when the preferred model disappeared", () => {
    const active = {
      instanceId,
      model: "removed-model",
      options: [{ id: "cyberAccessProgram", value: "daybreakRed" }],
    };
    const next = scheduledTaskDefaultModel(
      config.settings,
      { id: projectId, defaultModelSelection: projectSelection },
      deriveProviderInstanceEntries(config.providers),
      active,
    );
    expect(next).toEqual(projectSelection);
    const descriptors = scheduledTaskModelDescriptors(
      DEFAULT_UNIFIED_SETTINGS,
      config.providers,
      next!,
      projectId,
    );
    expect(descriptors).not.toBeNull();
    expect(decideDaybreakModelChange(active.options, next!, descriptors ?? [])).toMatchObject({
      type: "confirm",
      choices: [{ label: "Turn Off" }],
    });
  });

  it("ignores missing configured defaults and legacy models when choosing a fallback", () => {
    const missing = { instanceId, model: "removed-model" };
    const providers = config.providers.map((provider) => ({
      ...provider,
      models: [
        { slug: "legacy", name: "Legacy", isCustom: false, isLegacy: true, capabilities: null },
        ...provider.models,
      ],
    }));
    expect(
      scheduledTaskDefaultModel(
        { ...config.settings, defaultModelSelection: missing },
        { id: projectId, defaultModelSelection: missing },
        deriveProviderInstanceEntries(providers),
        missing,
      ),
    ).toEqual({ instanceId, model: "catalog-default" });
  });

  it("preserves a configured custom model that is absent from native discovery", () => {
    const preferred = { instanceId, model: "custom-model" };
    const settings = {
      ...config.settings,
      providerInstances: {
        [instanceId]: {
          driver: config.providers[0]!.driver,
          enabled: true,
          config: { customModels: [{ slug: preferred.model, name: "Custom model" }] },
        },
      },
    };
    expect(
      scheduledTaskDefaultModel(
        settings,
        { id: projectId },
        deriveProviderInstanceEntries(config.providers),
        preferred,
      ),
    ).toEqual(preferred);
  });

  it("resolves destination project enablement instead of carrying the source project's entries", () => {
    const sourceId = ProjectId.make("source");
    const settings = {
      ...config.settings,
      projectSettingsOverrides: {
        [sourceId]: { providerInstances: { [instanceId]: { enabled: false } } },
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };
    const sourceEntries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries(config.providers),
      settings,
      sourceId,
    );
    expect(scheduledTaskDefaultModel(settings, { id: projectId }, sourceEntries)).toEqual(
      environmentSelection,
    );
    const destinationEntries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries(config.providers),
      settings,
      projectId,
    );
    expect(scheduledTaskDefaultModel(settings, { id: sourceId }, destinationEntries)).toBeNull();
  });

  it("accepts a configured hidden destination default without exposing it in the picker", () => {
    const programOptions = [
      {
        id: "cyberAccessProgram",
        type: "select" as const,
        label: "Daybreak",
        options: [
          { id: "standard", label: "Off" },
          { id: "daybreakBlue", label: "Blue" },
        ],
      },
    ];
    const providers = config.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) =>
        model.slug === environmentSelection.model
          ? { ...model, capabilities: { optionDescriptors: programOptions } }
          : model,
      ),
    }));
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      defaultModelSelection: environmentSelection,
      providerModelPreferences: {
        [instanceId]: { hiddenModels: [environmentSelection.model], modelOrder: [] },
      },
    };
    expect(
      getCustomModelOptionsByInstance(settings, config.providers)
        .get(instanceId)
        ?.some((model) => model.slug === environmentSelection.model),
    ).toBe(false);
    expect(scheduledTaskModelDescriptors(settings, providers, environmentSelection, null)).toEqual(
      programOptions,
    );
    const active = [{ id: "cyberAccessProgram", value: "daybreakBlue" }];
    const preserved = decideDaybreakModelChange(
      active,
      environmentSelection,
      scheduledTaskModelDescriptors(settings, providers, environmentSelection, null) ?? [],
    );
    expect(preserved).toMatchObject({
      type: "ready",
      selection: { options: [...environmentSelection.options, ...active] },
    });
    expect(
      scheduledTaskModelDescriptors(
        settings,
        config.providers,
        {
          instanceId,
          model: "missing-model",
        },
        null,
      ),
    ).toBeNull();
    for (const provider of [
      { ...config.providers[0]!, installed: false },
      { ...config.providers[0]!, availability: "unavailable" as const },
      { ...config.providers[0]!, auth: { status: "unauthenticated" as const } },
    ]) {
      expect(
        scheduledTaskModelDescriptors(settings, [provider], environmentSelection, null),
      ).toBeNull();
    }
  });

  it("validates provider enablement for the destination project in both directions", () => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { [instanceId]: { driver: config.providers[0]!.driver, enabled: false } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };
    const providers = [{ ...config.providers[0]!, enabled: false }];
    expect(
      scheduledTaskModelDescriptors(settings, providers, environmentSelection, projectId),
    ).not.toBeNull();
    expect(
      scheduledTaskModelDescriptors(settings, providers, environmentSelection, null),
    ).toBeNull();
  });

  it("requires a downgrade decision for the destination project's enabled fallback provider", () => {
    const sourceId = ProjectId.make("source");
    const fallbackId = ProviderInstanceId.make("codex_fallback");
    const active = {
      ...environmentSelection,
      options: [{ id: "cyberAccessProgram", value: "daybreakBlue" }],
    };
    const settings = {
      ...config.settings,
      defaultModelSelection: active,
      providerInstances: {
        ...config.settings.providerInstances,
        [fallbackId]: { driver: config.providers[0]!.driver, enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    const providers = [config.providers[0]!, { ...config.providers[0]!, instanceId: fallbackId }];
    const sourceEntries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      sourceId,
    );
    const next = scheduledTaskDefaultModel(settings, { id: projectId }, sourceEntries);
    expect(next).toEqual({ instanceId: fallbackId, model: "catalog-default" });
    if (!next) throw new Error("Expected an enabled fallback provider");
    const descriptors = scheduledTaskModelDescriptors(
      { ...DEFAULT_UNIFIED_SETTINGS, providerInstances: settings.providerInstances },
      providers,
      next,
      projectId,
    );
    expect(descriptors).not.toBeNull();
    if (!descriptors) throw new Error("Expected an available destination model");
    const decision = decideDaybreakModelChange(active.options, next, descriptors);
    expect(decision).toMatchObject({ type: "confirm", choices: [{ label: "Turn Off" }] });
    expect(scheduledTaskDefaultModel(settings, { id: projectId }, sourceEntries, active)).toEqual(
      next,
    );
    expect(scheduledTaskDefaultModel(settings, { id: sourceId }, sourceEntries, active)).toEqual(
      active,
    );
    const explicit = { ...active, model: "project-model" };
    expect(scheduledTaskDefaultModel(settings, { id: sourceId }, sourceEntries, explicit)).toEqual(
      explicit,
    );
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
});

it("rejects dedupe templates without a request placeholder", () => {
  const draft = taskToDraft({ ...legacyTask, schedule: { type: "webhook", signature: null } });
  expect(scheduleFromDraft({ ...draft, replayKey: "literal" })).toBeNull();
  expect(scheduleFromDraft({ ...draft, coalesceKey: "{{body.bad" })).toBeNull();
});
