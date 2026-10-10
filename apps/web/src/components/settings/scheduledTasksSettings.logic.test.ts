import {
  EnvironmentId,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  scheduledTaskDefaultModel,
  scheduledTaskDefaultProjectId,
  scheduledTaskProjectChoices,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  taskToDraft,
  workspaceStrategyFromDraft,
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

// Project IDs are environment-local. This unrelated server checkout deliberately
// shares an ID with a laptop checkout in the selected group.
const sameIdElsewhere = member("first", serverId);
const groups = [group("t3code", [first, second, third]), group("other", [other, sameIdElsewhere])];
const tasks = [first, second, third, other, sameIdElsewhere].map((project, index) => ({
  id: `task-${index}`,
  environmentId: project.environmentId,
  projectId: project.id,
}));

describe("scheduled task project choices", () => {
  const scratchWorkspaceRoot = "/home/t3/scratch";
  const scratch = { ...member("scratch", laptopId), workspaceRoot: scratchWorkspaceRoot };
  const remoteScratch = { ...scratch, environmentId: serverId };
  const allProjects = [scratch, first, second, third, remoteScratch];

  it("offers No project before the environment's scratch folder has been created", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    expect(scheduledTaskProjectChoices(scope, laptopId, [], scratchWorkspaceRoot)).toEqual({
      projects: [],
      scratchProject: null,
      canSelectNoProject: true,
    });
  });

  it("keeps scratch behind No project and resolves it only on the selected environment", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    expect(scheduledTaskProjectChoices(scope, laptopId, allProjects, scratchWorkspaceRoot)).toEqual(
      {
        projects: [first, second],
        scratchProject: scratch,
        canSelectNoProject: true,
      },
    );
    expect(scheduledTaskProjectChoices(scope, serverId, allProjects, scratchWorkspaceRoot)).toEqual(
      {
        projects: [third],
        scratchProject: remoteScratch,
        canSelectNoProject: true,
      },
    );
  });

  it.each<SettingsScopeSearch>([
    { project: "t3code" },
    { project: "t3code", checkout: second.physicalProjectKey },
    { project: "missing" },
    { machine: serverId },
  ])("does not offer No project outside the selected settings scope: %o", (search) => {
    const scope = resolveSettingsScope(search, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, laptopId, allProjects, scratchWorkspaceRoot);
    expect(choices.scratchProject).toBeNull();
    expect(choices.canSelectNoProject).toBe(false);
  });

  it("does not offer No project when the environment has no available scratch folder", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    expect(scheduledTaskProjectChoices(scope, laptopId, [first], null)).toEqual({
      projects: [first],
      scratchProject: null,
      canSelectNoProject: false,
    });
  });
});

describe("scheduled task destination defaults", () => {
  it("stores No project when the editor opens before ordinary projects load", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, laptopId, [], "/home/t3/scratch");
    expect(scheduledTaskDefaultProjectId(choices)).toBeNull();
  });

  it("defaults to the first scoped project when one is available", () => {
    const scope = resolveSettingsScope({ project: "t3code" }, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, serverId, [other, third], null);
    expect(scheduledTaskDefaultProjectId(choices)).toBe(third.id);
  });

  it("preserves No project when switching to an environment that supports it", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, serverId, [third], "/remote/scratch");
    expect(scheduledTaskDefaultProjectId(choices, true)).toBeNull();
  });

  it("switches to an available project when the destination does not support Scratch", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, serverId, [third], null);
    expect(scheduledTaskDefaultProjectId(choices, true)).toBe(third.id);
  });

  it("leaves the destination unset when neither Scratch nor a project is available", () => {
    const scope = resolveSettingsScope({}, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, serverId, [], null);
    expect(scheduledTaskDefaultProjectId(choices, true)).toBe("");
  });

  it("requires a project when the settings scope excludes Scratch", () => {
    const scope = resolveSettingsScope({ project: "t3code" }, groups, environments);
    const choices = scheduledTaskProjectChoices(scope, serverId, [third], "/remote/scratch");
    expect(scheduledTaskDefaultProjectId(choices, true)).toBe(third.id);
  });
});

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

  it("does not offer an unrelated environment's same-ID project when creating a task", () => {
    const scope = resolveSettingsScope({ project: "t3code" }, groups, environments);
    const serverProjects = [third, other, sameIdElsewhere];
    expect(
      serverProjects.filter((project) => matchesScheduledTaskScope(scope, serverId, project.id)),
    ).toEqual([third]);
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

  it.each([true, false])("preserves an explicit origin flag of %s", (startFromOrigin) => {
    const draft = taskToDraft({
      ...legacyTask,
      workspaceStrategy: { type: "worktree", baseRef: "release", startFromOrigin },
    });
    expect(draft.startFromOrigin).toBe(startFromOrigin);
  });
});

describe("scheduled task workspace selection", () => {
  it.each<ScheduledTask["workspaceStrategy"]>([
    { type: "root" },
    { type: "worktree", baseRef: "release", startFromOrigin: true },
    { type: "existing_worktree", worktreePath: "/repos/checkout" },
  ])("uses a scratch folder after switching from %o to No project", (workspaceStrategy) => {
    const draft = taskToDraft({ ...legacyTask, workspaceStrategy });
    expect(workspaceStrategyFromDraft(draft, true)).toEqual({ type: "root" });
    expect(workspaceStrategyFromDraft(draft, false)).toEqual(workspaceStrategy);
  });
});

describe("webhook scheduled tasks", () => {
  const signature = { header: "x-signature", encoding: "base64", prefix: "" } as const;
  const webhookTask: ScheduledTask = {
    ...legacyTask,
    schedule: { type: "webhook", signature },
    webhook: { path: "/api/hooks/legacy-task/token", url: null, hasSecret: true },
  };

  it("keeps a stored secret when the secret field is left blank", () => {
    const draft = taskToDraft(webhookTask);
    expect(draft.scheduleMode).toBe("webhook");
    expect(draft.signatureSecret).toBe("");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature,
      maxDeliveryAgeMinutes: null,
    });
    expect(scheduleFromDraft({ ...draft, signatureSecret: " new " })).toEqual({
      type: "webhook",
      signature: { ...signature, secret: "new" },
      maxDeliveryAgeMinutes: null,
    });
  });

  it("drops the signature when it is switched off and offers GitHub's settings", () => {
    const draft = taskToDraft({ ...webhookTask, schedule: { type: "webhook", signature: null } });
    expect(draft.signatureEnabled).toBe(false);
    expect(draft.signatureHeader).toBe("x-hub-signature-256");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature: null,
      maxDeliveryAgeMinutes: null,
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
      });
    }
    for (const invalid of ["0", "-5", "1.5", "abc", "1441"]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: invalid })).toBeNull();
    }
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
