import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";
import {
  movePrismPreference,
  planPrismModelsPatch,
  prismEffortOptions,
  prismModelChoices,
  prismWriteObserved,
} from "./PrismSettings.logic";
import { resolveSettingsScope } from "./settingsScope";
import { persistScopedSettingsPatch } from "./scopedSettings";

const first = { instanceId: ProviderInstanceId.make("codex"), model: "first", effort: "high" };
const second = { instanceId: ProviderInstanceId.make("opencode"), model: "second" };
const rolesLanes = {
  ...DEFAULT_SERVER_SETTINGS.prismRoles.worker.lanes,
  easy: [second],
  hard: [{ ...first, effort: "low" }],
};
const roles = {
  ...DEFAULT_SERVER_SETTINGS.prismRoles,
  worker: {
    ...DEFAULT_SERVER_SETTINGS.prismRoles.worker,
    instructions: "Keep this kit",
    skills: ["test"],
    lanes: { ...rolesLanes, medium: [first] },
  },
};
const environment = (id: string, connected = true) => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
  serverConfig: {
    settings: { ...DEFAULT_SERVER_SETTINGS, prismRoles: roles },
    environment: { capabilities: { projectSettingsOverrides: true } },
  },
});

describe("Prism role preferences", () => {
  it("moves preferences with their effort and does not mutate or wrap the list", () => {
    const original = [first, second];
    expect(movePrismPreference(original, 0, 1)).toEqual([second, first]);
    expect(original).toEqual([first, second]);
    expect(movePrismPreference(original, 0, -1)).toBe(original);
    expect(movePrismPreference(original, 1, 1)).toBe(original);
    expect(movePrismPreference([], 0, 1)).toEqual([]);
  });

  it("uses provider effort choices and excludes prompt-only controls", () => {
    expect(
      prismEffortOptions({
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: "build", label: "Build" }],
          },
          {
            id: "variant",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "deep", label: "Deep" },
              { id: "prompt", label: "Prompt" },
            ],
            promptInjectedValues: ["prompt"],
          },
        ],
      }),
    ).toEqual([{ id: "deep", label: "Deep" }]);
    expect(prismEffortOptions(null)).toEqual([]);
  });

  it("replaces model arrays, including clearing them, without changing role kits or offline environments", () => {
    const envs = [environment("one"), environment("two", false)];
    const scope = resolveSettingsScope({}, [], envs);
    const plan = planPrismModelsPatch(scope, envs, "worker", "medium", [second]);
    expect(plan.serverWrites.map((write) => write.environmentId)).toEqual(["one"]);
    const next = applyServerSettingsPatch(
      envs[0]!.serverConfig.settings,
      plan.serverWrites[0]!.patch,
    );
    expect(next.prismRoles.worker).toEqual({
      ...roles.worker,
      lanes: { ...rolesLanes, medium: [second] },
    });
    expect(next.prismRoles.planner).toEqual(roles.planner);
    const clear = planPrismModelsPatch(scope, envs, "worker", "medium", []);
    expect(
      applyServerSettingsPatch(next, clear.serverWrites[0]!.patch).prismRoles.worker.lanes.medium,
    ).toEqual([]);
  });

  it("preserves each project's own kit when writing a project override", () => {
    const env = environment("one");
    const projectId = ProjectId.make("project");
    const member = {
      id: projectId,
      environmentId: env.environmentId,
      title: "Project",
      workspaceRoot: "/repo",
      physicalProjectKey: "one:/repo",
      environmentLabel: "one",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
    };
    const scopedEnv = {
      ...env,
      serverConfig: {
        ...env.serverConfig,
        settings: {
          ...env.serverConfig.settings,
          projectSettingsOverrides: {
            [projectId]: {
              prismRoles: {
                ...roles,
                worker: { ...roles.worker, instructions: "Project instructions" },
              },
            },
          },
        },
      },
    };
    const group = {
      ...member,
      projectKey: "group",
      displayName: "Project",
      memberProjects: [member],
      memberProjectRefs: [{ environmentId: env.environmentId, projectId }],
      groupedProjectCount: 1,
      environmentPresence: "remote-only" as const,
      allRemoteMembersAreDesktopLocal: false,
      allRemoteMembersAreWsl: false,
      remoteEnvironmentLabels: ["one"],
    };
    const scope = resolveSettingsScope({ project: "group" }, [group], [scopedEnv]);
    const plan = planPrismModelsPatch(scope, [scopedEnv], "worker", "medium", [second, first]);
    const next = applyServerSettingsPatch(
      scopedEnv.serverConfig.settings,
      plan.serverWrites[0]!.patch,
    );
    expect(next.prismRoles).toEqual(roles);
    expect(next.projectSettingsOverrides[projectId]?.prismRoles?.worker).toEqual({
      ...roles.worker,
      instructions: "Project instructions",
      lanes: { ...rolesLanes, medium: [second, first] },
    });
    expect(next.projectSettingsOverrides[projectId]?.prismRoles?.reviewer).toEqual(roles.reviewer);
  });

  it("reports disconnected scopes and partial save failures", async () => {
    const offline = environment("offline", false);
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], [offline]);
    expect(
      planPrismModelsPatch(scope, [offline], "worker", "medium", []).unavailableReason,
    ).toBeTruthy();
    const envs = [environment("one"), environment("two")];
    const plan = planPrismModelsPatch(
      resolveSettingsScope({}, [], envs),
      envs,
      "worker",
      "medium",
      [first],
    );
    const result = await persistScopedSettingsPatch(
      plan,
      async ({ environmentId }) => ({ _tag: environmentId === "one" ? "Success" : "Failure" }),
      () => {},
    );
    expect(result.savedEnvironmentCount).toBe(1);
    expect(result.failedEnvironments.map((env) => env.label)).toEqual(["two"]);
  });
});

it("offers only enabled models available across the selected scope", () => {
  const entry = {
    instanceId: first.instanceId,
    displayName: "Codex",
    enabled: true,
    isAvailable: true,
    models: [],
  };
  const options = new Map([
    [
      first.instanceId,
      [
        { slug: "enabled", name: "Enabled" },
        { slug: "unavailable", name: "Unavailable", isUnavailable: true },
        { slug: "other-scope", name: "Other scope" },
      ],
    ],
  ]);
  expect(
    prismModelChoices([entry], options, (_, model) =>
      model === "other-scope" ? "Unavailable elsewhere" : null,
    ).map((choice) => choice.preference.model),
  ).toEqual(["enabled"]);
  expect(prismModelChoices([{ ...entry, enabled: false }], options, () => null)).toEqual([]);
  expect(prismModelChoices([{ ...entry, isAvailable: false }], options, () => null)).toEqual([]);
});

it("keeps the same model at distinct efforts as separate ordered entries", () => {
  const envs = [environment("one")];
  const models = [first, { ...first, effort: "low" }];
  const plan = planPrismModelsPatch(
    resolveSettingsScope({}, [], envs),
    envs,
    "reviewer",
    "hard",
    models,
  );
  const next = applyServerSettingsPatch(
    envs[0]!.serverConfig.settings,
    plan.serverWrites[0]!.patch,
  );
  expect(next.prismRoles.reviewer.lanes.hard).toEqual(models);
  expect(next.prismRoles.worker).toEqual(roles.worker);
});

it("keeps the save barrier until the updated settings snapshot arrives", () => {
  const envs = [environment("one")];
  const plan = planPrismModelsPatch(resolveSettingsScope({}, [], envs), envs, "worker", "easy", [
    first,
  ]);
  const expectation = {
    kind: "lane" as const,
    role: "worker" as const,
    lane: "easy" as const,
    models: [first],
  };
  expect(prismWriteObserved(plan, envs, expectation)).toBe(false);
  const updated = {
    ...envs[0]!,
    serverConfig: {
      ...envs[0]!.serverConfig,
      settings: applyServerSettingsPatch(
        envs[0]!.serverConfig.settings,
        plan.serverWrites[0]!.patch,
      ),
    },
  };
  expect(prismWriteObserved(plan, [updated], expectation)).toBe(true);
  expect(prismWriteObserved(plan, [], expectation)).toBe(false);
  // Failed writes do not wait forever for a snapshot that will never arrive.
  expect(prismWriteObserved({ ...plan, serverWrites: [] }, envs, expectation)).toBe(true);
});
