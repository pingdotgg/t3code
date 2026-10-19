import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  listProjectOverrides,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  resolveUnsupportedSettingKeys,
  scopedDisplaySettings,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  scopedSettingsUnsupportedTargets,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  droppedSettingKeysAtom,
  droppedSettingKeysFor,
  recordDroppedSettingKeys,
} from "./droppedSettingKeys";

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
    projectOverrides?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
            environment: {
              capabilities: { projectSettingsOverrides: options.projectOverrides !== false },
            },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({}, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
const checkout = resolveSettingsScope(
  { project: group.projectKey, machine: server.environmentId, checkout: member.physicalProjectKey },
  [group],
  environments,
);

describe("scoped settings targets", () => {
  it("uses the named environment even when a different primary is available", () => {
    const selected = selectScopedSettingsEnvironments(named, environments, laptop.environmentId);
    expect(selected.environments).toEqual([server]);
    expect(selected.environment).toBe(server);
  });

  it("keeps an offline named environment selected without falling back to primary", () => {
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], environments);
    const selected = selectScopedSettingsEnvironments(scope, environments, laptop.environmentId);
    expect(selected.environments).toEqual([offline]);
    expect(selected.connectedEnvironments).toEqual([]);
    expect(selected.environment).toBeNull();
    expect(
      planScopedSettingsPatch(scope, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "Connect Offline to save this setting.",
    });
  });

  it("prefers the selected primary as the aggregate representative without including disconnected targets", () => {
    const selected = selectScopedSettingsEnvironments(all, environments, server.environmentId);
    expect(selected.environment).toBe(server);
    expect(selected.environments).toEqual(environments);
    expect(selected.connectedEnvironments).toEqual([laptop, server]);
  });

  it("resolves each member's effective settings and source at project scope", () => {
    const overridden = environment("Server", {
      settings: {
        defaultAutoPull: false,
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      },
    });
    const targets = resolveScopedSettingsTargets(project, [laptop, overridden]);
    expect(targets.map((target) => [target.projectId, target.settings.defaultAutoPull])).toEqual([
      [projectId, true],
      [laptopProjectId, false],
    ]);
    expect(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("mixed");
    expect(scopedSettingsSource([targets[0]!], ["defaultAutoPull"])).toBe("project");
    expect(scopedSettingsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
    expect(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(true);
  });
});

describe("scoped settings writes", () => {
  it("edits the effective machine policy without changing other machines' rules", () => {
    const custom = environment("Laptop", {
      settings: {
        worktreeCleanup: {
          mode: "custom",
          rules: {
            worktreeAfterDays: 12,
            worktreeSettledAfterDays: null,
            worktreeOnDelete: true,
            worktreeOnMerge: true,
            worktreeUnchanged: false,
            worktreeKeepWhen: "uncommitted-changes",
          },
        },
      },
    });
    const disabled = environment("Server", {
      settings: { worktreeCleanup: { mode: "off" } },
    });
    const targets = [custom, disabled];
    const plan = planScopedSettingsPatch(all, targets, {
      storageCleanup: { worktreeOnDelete: false },
    });
    const policies = plan.serverWrites.map((write, index) =>
      resolveWorktreeCleanup(
        applyServerSettingsPatch(targets[index]!.serverConfig!.settings, write.patch),
        null,
      ),
    );
    expect(policies).toEqual([
      {
        worktreeAfterDays: 12,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: true,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
      {
        worktreeAfterDays: null,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: false,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
    ]);
  });
  it("isolates a formerly shared server preference to the named environment", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, { sidebarAutoSettleOnMerge: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls).toEqual([
      [
        {
          environmentId: server.environmentId,
          input: { patch: { sidebarAutoSettleOnMerge: false } },
        },
      ],
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  it("writes an aggregate preference only to connected environments with loaded configuration", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, { enableProviderUpdateChecks: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls.map(([input]) => input.environmentId)).toEqual([
      laptop.environmentId,
      server.environmentId,
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  describe("an environment that saves but drops keys it does not know", () => {
    const upgradedLaptop = (saved: Partial<ServerSettings>) =>
      vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
        _tag: "Success" as const,
        value: {
          ...DEFAULT_SERVER_SETTINGS,
          ...(environmentId === laptop.environmentId ? saved : {}),
        },
      }));
    const outcome = async (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      persistServer: ReturnType<typeof upgradedLaptop>,
    ) => {
      const result = await persistScopedSettingsPatch(plan, persistServer, vi.fn());
      return {
        saved: result.savedEnvironments.map(({ label }) => label),
        failed: result.failedEnvironments.map(({ label, message }) => ({ label, message })),
      };
    };
    const unsupported = [
      {
        label: server.label,
        message: "This environment does not support this setting. Update T3 Code on it.",
      },
    ];

    it("learns a dropped toggle until the server updates, so the next click can turn it off", async () => {
      appAtomRegistry.set(droppedSettingKeysAtom, new Map());
      try {
        const result = await persistScopedSettingsPatch(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: true }),
          upgradedLaptop({ reviewGuidesEnabled: true }),
          vi.fn(),
        );
        expect(result.failedEnvironments.map(({ label, message }) => ({ label, message }))).toEqual(
          unsupported,
        );
        for (const failure of result.failedEnvironments) {
          recordDroppedSettingKeys(failure.environmentId, "old", failure.droppedKeys);
        }
        const learned = (version: string, advertised?: readonly string[]) => ({
          ...server,
          unsupportedSettingKeys: resolveUnsupportedSettingKeys(
            advertised,
            droppedSettingKeysFor(
              appAtomRegistry.get(droppedSettingKeysAtom),
              server.environmentId,
              version,
            ),
          ),
        });
        const enabledLaptop = environment("Laptop", { settings: { reviewGuidesEnabled: true } });
        const pair = [enabledLaptop, learned("old")];
        const targets = resolveScopedSettingsTargets(all, pair);
        expect(scopedSettingsAreMixed(targets, ["reviewGuidesEnabled"])).toBe(false);
        expect(scopedDisplaySettings(targets[1]!, targets).reviewGuidesEnabled).toBe(true);
        expect(
          planScopedSettingsPatch(all, pair, { reviewGuidesEnabled: false }).serverWrites.map(
            ({ environmentId, patch }) => ({ environmentId, patch }),
          ),
        ).toEqual([{ environmentId: laptop.environmentId, patch: { reviewGuidesEnabled: false } }]);
        for (const updated of [learned("new"), learned("old", ["reviewGuidesEnabled"])]) {
          expect(
            planScopedSettingsPatch(named, [updated], { reviewGuidesEnabled: true }).serverWrites,
          ).toMatchObject([
            { environmentId: server.environmentId, patch: { reviewGuidesEnabled: true } },
          ]);
        }
      } finally {
        appAtomRegistry.set(droppedSettingKeysAtom, new Map());
      }
    });

    it("reports dropped text but accepts the server trimming it", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuideInstructions: " Read tests " }),
          upgradedLaptop({ reviewGuideInstructions: "Read tests" }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports a dropped key inside a project override", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(project, environments, { defaultAutoPull: true }),
          upgradedLaptop({
            projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } },
          }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("learns a dropped project key without disabling its environment setting", async () => {
      const patch = { defaultAutoPull: true, enableAgentBrowserAccess: false };
      const before = [
        environment("Laptop", { settings: { enableAgentBrowserAccess: false } }),
        environment("Server", { settings: { enableAgentBrowserAccess: true } }),
      ];
      const saved = before.map((environment) => ({
        ...environment,
        serverConfig: {
          ...environment.serverConfig!,
          settings: {
            ...environment.serverConfig!.settings,
            projectSettingsOverrides:
              environment.environmentId === laptop.environmentId
                ? { [laptopProjectId]: patch }
                : { [projectId]: { defaultAutoPull: true } },
          },
        },
      }));
      const previousDropped = appAtomRegistry.get(droppedSettingKeysAtom);
      try {
        for (const advertised of [
          undefined,
          ["defaultAutoPull", "enableAgentBrowserAccess", "projectSettingsOverrides"],
        ]) {
          appAtomRegistry.set(droppedSettingKeysAtom, new Map());
          const withSupport = (environment: (typeof before)[number]) => ({
            ...environment,
            unsupportedSettingKeys: resolveUnsupportedSettingKeys(
              advertised,
              droppedSettingKeysFor(
                appAtomRegistry.get(droppedSettingKeysAtom),
                environment.environmentId,
                "old",
              ),
            ),
          });
          const result = await persistScopedSettingsPatch(
            planScopedSettingsPatch(project, before.map(withSupport), patch),
            async ({ environmentId }) => ({
              _tag: "Success",
              value: saved.find((environment) => environment.environmentId === environmentId)!
                .serverConfig.settings,
            }),
            vi.fn(),
          );
          expect(result.savedEnvironments.map(({ label }) => label)).toEqual([laptop.label]);
          expect(
            result.failedEnvironments.map(({ label, droppedKeys }) => ({ label, droppedKeys })),
          ).toEqual([
            {
              label: server.label,
              droppedKeys: ["projectSettingsOverrides.enableAgentBrowserAccess"],
            },
          ]);
          for (const failure of result.failedEnvironments) {
            recordDroppedSettingKeys(failure.environmentId, "old", failure.droppedKeys);
          }
          const learned = saved.map(withSupport);
          const metadata = advertised ? "advertised support" : "legacy support";

          for (const scope of [project, checkout]) {
            const retry = planScopedSettingsPatch(scope, learned, patch);
            expect
              .soft(
                retry.serverWrites.find(
                  ({ environmentId }) => environmentId === server.environmentId,
                )?.patch,
                `${metadata}: ${scope.kind} retry skips only the dropped override`,
              )
              .toEqual({
                projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
              });
          }
          for (const scope of [project, checkout]) {
            expect(
              planScopedSettingsClear(scope, learned, [
                "enableAgentBrowserAccess",
              ]).serverWrites.map(({ environmentId }) => environmentId),
            ).toEqual(scope.kind === "project" ? [laptop.environmentId] : []);
          }
          const overrides = listProjectOverrides(learned, ["enableAgentBrowserAccess"]);
          expect(overrides).toEqual([
            { environmentId: laptop.environmentId, projectId: laptopProjectId },
          ]);
          expect(
            planProjectOverridesClear(
              learned,
              [{ environmentId: server.environmentId, projectId }],
              ["enableAgentBrowserAccess"],
            ).serverWrites,
          ).toEqual([]);
          const projectTargets = resolveScopedSettingsTargets(project, learned);
          expect
            .soft(
              scopedSettingsAreMixed(projectTargets, ["enableAgentBrowserAccess"]),
              `${metadata}: unsupported override does not make the project row mixed`,
            )
            .toBe(false);
          expect
            .soft(
              scopedDisplaySettings(projectTargets[0]!, projectTargets).enableAgentBrowserAccess,
              `${metadata}: project display uses the supported laptop override`,
            )
            .toBe(false);

          for (const scope of [named, all]) {
            const selected = selectScopedSettingsEnvironments(scope, learned, server.environmentId);
            const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments);
            const representative = targets.find(
              ({ environmentId }) => environmentId === server.environmentId,
            )!;
            expect
              .soft(
                scopedSettingsUnsupportedTargets(targets, ["enableAgentBrowserAccess"]).map(
                  ({ label }) => label,
                ),
                `${metadata}: ${scope.kind} keeps the top-level setting supported`,
              )
              .toEqual([]);
            expect
              .soft(
                scopedDisplaySettings(representative, targets).enableAgentBrowserAccess,
                `${metadata}: ${scope.kind} displays the server's true top-level value`,
              )
              .toBe(true);
            expect
              .soft(
                scopedSettingsAreMixed(targets, ["enableAgentBrowserAccess"]),
                `${metadata}: ${scope.kind} compares genuine top-level values`,
              )
              .toBe(scope.kind === "all");
            expect
              .soft(
                planScopedSettingsPatch(scope, learned, {
                  enableAgentBrowserAccess: false,
                }).serverWrites.map(({ environmentId, patch }) => ({ environmentId, patch })),
                `${metadata}: ${scope.kind} can still write the top-level setting`,
              )
              .toEqual(
                selected.connectedEnvironments.map(({ environmentId }) => ({
                  environmentId,
                  patch: { enableAgentBrowserAccess: false },
                })),
              );
          }
          const reset = planScopedSettingsClear(checkout, learned, ["defaultAutoPull"]);
          expect(reset.serverWrites[0]?.patch).toEqual({
            projectSettingsOverrides: { [projectId]: null },
          });
          const resetResult = await persistScopedSettingsPatch(
            reset,
            async () => ({ _tag: "Success", value: saved[1]!.serverConfig.settings }),
            vi.fn(),
          );
          expect(resetResult.failedEnvironments[0]?.droppedKeys).toEqual([
            "projectSettingsOverrides.defaultAutoPull",
          ]);
          for (const failure of resetResult.failedEnvironments) {
            recordDroppedSettingKeys(failure.environmentId, "old", failure.droppedKeys);
          }
          const afterReset = saved.map(withSupport);
          expect(
            planScopedSettingsClear(checkout, afterReset, ["defaultAutoPull"]).serverWrites,
          ).toEqual([]);
          expect(
            planScopedSettingsPatch(named, afterReset, { defaultAutoPull: false }).serverWrites,
          ).toHaveLength(1);
          expect(
            droppedSettingKeysFor(
              appAtomRegistry.get(droppedSettingKeysAtom),
              server.environmentId,
              "new",
            ),
          ).toBeUndefined();
        }
      } finally {
        appAtomRegistry.set(droppedSettingKeysAtom, previousDropped);
      }
    });

    it("accepts a write that matches what the environment already had", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: false }),
          upgradedLaptop({}),
        ),
      ).toEqual({ saved: [laptop.label, server.label], failed: [] });
    });
  });

  it("persists client keys locally at any scope alongside server keys", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, {
        diffIgnoreWhitespace: false,
        enableProviderUpdateChecks: false,
      }),
      persistServer,
      persistClient,
    );
    expect(persistClient).toHaveBeenCalledExactlyOnceWith({ diffIgnoreWhitespace: false });
    expect(persistServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: server.environmentId,
      input: { patch: { enableProviderUpdateChecks: false } },
    });
  });

  it("writes project overrides into each member's entry on its environment", () => {
    const withExisting = environment("Server", {
      settings: {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    });
    const plan = planScopedSettingsPatch(project, [laptop, withExisting], {
      defaultAutoPull: true,
    });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: {
            [projectId]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
          },
        },
      },
      {
        environmentId: laptop.environmentId,
        label: laptop.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planScopedSettingsPatch(checkout, [laptop, server], { defaultAutoPull: true }),
    ).toMatchObject({
      serverWrites: [{ environmentId: server.environmentId }],
    });
  });

  it("keeps each project's other cleanup rules when changing one rule across machines", () => {
    const machine = environment("Laptop", {
      settings: {
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 30 },
      },
    });
    const customized = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            defaultAutoPull: true,
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: 8,
                worktreeSettledAfterDays: null,
                worktreeOnDelete: false,
                worktreeOnMerge: true,
                worktreeUnchanged: false,
                worktreeKeepWhen: "uncommitted-changes",
              },
            },
          },
        },
      },
    });
    const plan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    });
    const settledPlan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeSettledAfterDays: 0 } },
    });
    expect(
      settledPlan.serverWrites.map((write) => write.patch.projectSettingsOverrides),
    ).toMatchObject([
      { [projectId]: { worktreeCleanup: { rules: { worktreeSettledAfterDays: 0 } } } },
      { [laptopProjectId]: { worktreeCleanup: { rules: { worktreeSettledAfterDays: 0 } } } },
    ]);
    expect(plan.serverWrites.map((write) => write.patch.projectSettingsOverrides)).toEqual([
      {
        [projectId]: {
          defaultAutoPull: true,
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 8,
              worktreeSettledAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: true,
              worktreeUnchanged: false,
              worktreeKeepWhen: "uncommitted-changes",
            },
          },
        },
      },
      {
        [laptopProjectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 30,
              worktreeSettledAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: false,
              worktreeUnchanged: false,
              worktreeKeepWhen: "uncommitted-changes",
            },
          },
        },
      },
    ]);
    expect(
      planScopedSettingsClear(checkout, [customized], ["worktreeCleanup"]).serverWrites[0]?.patch,
    ).toEqual({
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    expect(
      planScopedSettingsPatch(project, [machine, customized], {
        storageCleanup: { browserArtifactsAfterDays: 8 },
      }).serverWrites,
    ).toEqual([]);
  });

  it("scopes agent device access to projects while keeping hub and hosts environment-wide", () => {
    const plan = planScopedSettingsPatch(project, [laptop, server], {
      enableAgentDeviceAccess: true,
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } } },
      { projectSettingsOverrides: { [laptopProjectId]: { enableAgentDeviceAccess: true } } },
    ]);
    for (const patch of [{ enableDeviceSupport: true }, { deviceHosts: [] }]) {
      expect(planScopedSettingsPatch(project, environments, patch).serverWrites).toEqual([]);
    }
  });

  it("refuses environment-wide keys and older servers at project scope", () => {
    expect(
      planScopedSettingsPatch(project, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a project.",
    });
    const legacy = environment("Server", { projectOverrides: false });
    expect(
      planScopedSettingsPatch(checkout, [laptop, legacy], { defaultAutoPull: true }),
    ).toMatchObject({ serverWrites: [], unavailableReason: expect.stringContaining("update") });
  });

  it("clears overrides per member and removes an emptied entry", () => {
    const withOverrides = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const plan = planScopedSettingsClear(checkout, [laptop, withOverrides], ["defaultAutoPull"]);
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } } },
      },
    ]);
    expect(
      planScopedSettingsClear(
        checkout,
        [laptop, withOverrides],
        ["defaultAutoPull", "enableAgentBrowserAccess"],
      ).serverWrites[0]?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: null } });
  });

  it("never substitutes an environment-default write for an invalid scope", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({}, [], selected);
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: "settings:write",
            message: "This connection lacks permission to change settings.",
          }),
        ),
      })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      persistServer,
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.savedEnvironments.map(({ label }) => label)).toEqual([
      laptop.label,
      fourth.label,
    ]);
    expect(result.failedEnvironments.map(({ message }) => message)).toEqual([
      "This connection lacks permission to change settings.",
      "Disconnected during save",
    ]);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });
});

describe("scoped settings mixed values", () => {
  it.each([
    ["no project override capability", environment("Server", { projectOverrides: false })],
    [
      "no project override container support",
      { ...server, unsupportedSettingKeys: new Set(["projectSettingsOverrides"]) },
    ],
  ])("excludes a checkout with %s from project values and sources", (_reason, incapable) => {
    const supported = environment("Laptop", {
      settings: {
        projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } },
      },
    });
    const selected = [incapable, supported];
    const targets = resolveScopedSettingsTargets(project, selected);
    expect.soft(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(false);
    expect.soft(scopedDisplaySettings(targets[0]!, targets).defaultAutoPull).toBe(true);
    expect.soft(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("project");
    expect(
      planScopedSettingsPatch(project, selected, { defaultAutoPull: false }).serverWrites.map(
        ({ environmentId }) => environmentId,
      ),
    ).toEqual([laptop.environmentId]);

    const environmentTargets = resolveScopedSettingsTargets(all, [
      incapable,
      environment("Laptop", { settings: { defaultAutoPull: true } }),
    ]);
    expect(scopedSettingsAreMixed(environmentTargets, ["defaultAutoPull"])).toBe(true);
    expect(scopedDisplaySettings(environmentTargets[0]!, environmentTargets).defaultAutoPull).toBe(
      false,
    );
  });

  it("compares only requested settings across connected targets", () => {
    const changed = environment("Changed", { settings: { enableAgentBrowserAccess: false } });
    const targets = resolveScopedSettingsTargets(all, [laptop, changed]);
    expect(scopedSettingsAreMixed(targets, ["enableAgentBrowserAccess"])).toBe(true);
    expect(scopedSettingsAreMixed(targets, ["enableProviderUpdateChecks"])).toBe(false);
    expect(scopedSettingsAreMixed([], ["enableAgentBrowserAccess"])).toBe(false);
  });

  it("treats independently decoded equal nested settings as the same value", () => {
    const style = {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      mode: "custom" as const,
      customInstructions: "Use plain language",
    };
    const first = environment("First", { settings: { sourceControlWritingStyle: { ...style } } });
    const second = environment("Second", { settings: { sourceControlWritingStyle: { ...style } } });
    const targets = resolveScopedSettingsTargets(all, [first, second]);
    expect(scopedSettingsAreMixed(targets, ["sourceControlWritingStyle"])).toBe(false);
  });
});

describe("project overrides at environment scope", () => {
  const laptop = EnvironmentId.make("laptop");
  const desk = EnvironmentId.make("desk");
  const fleet = ProjectId.make("fleet");
  const t3 = ProjectId.make("t3");
  const environment = (
    environmentId: EnvironmentId,
    overrides: ServerSettings["projectSettingsOverrides"],
  ) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  });

  it("lists only the projects that override the keys", () => {
    const entries = listProjectOverrides(
      [
        environment(laptop, {
          [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
          [t3]: { defaultThreadEnvMode: "local" },
        }),
        environment(desk, { [fleet]: { defaultAutoPull: false } }),
      ],
      ["defaultAutoPull"],
    );
    expect(entries).toEqual([
      { environmentId: laptop, projectId: fleet },
      { environmentId: desk, projectId: fleet },
    ]);
  });

  it("clears only those keys and drops entries that become empty", () => {
    const plan = planProjectOverridesClear(
      [
        environment(laptop, {
          [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
          [t3]: { defaultAutoPull: true },
        }),
      ],
      [
        { environmentId: laptop, projectId: fleet },
        { environmentId: laptop, projectId: t3 },
      ],
      ["defaultAutoPull"],
    );
    expect(plan.serverWrites).toEqual([
      {
        environmentId: laptop,
        label: laptop,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: { [fleet]: { defaultThreadEnvMode: "local" }, [t3]: null },
        },
      },
    ]);
  });
});

describe("null patches at project scope", () => {
  it("removes the override for keys that cannot store null and keeps it for keys that can", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const scope = {
      kind: "project" as const,
      group: {} as never,
      environmentId: null,
      label: "fleet",
      members: [{ id: projectId, environmentId } as never],
      environmentIds: [environmentId],
    };
    const environments = [
      {
        environmentId,
        label: "Laptop",
        connection: { phase: "connected" as const },
        serverConfig: {
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [projectId]: { defaultThreadEnvMode: "worktree" as const, defaultAutoPull: true },
            },
          },
          environment: { capabilities: { projectSettingsOverrides: true } },
        },
      },
    ];
    expect(
      planScopedSettingsPatch(scope, environments, { defaultThreadEnvMode: null }).serverWrites[0]
        ?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } } });
    expect(
      planScopedSettingsPatch(scope, environments, { defaultModelSelection: null }).serverWrites[0]
        ?.patch,
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          defaultThreadEnvMode: "worktree",
          defaultAutoPull: true,
          defaultModelSelection: null,
        },
      },
    });
  });
});

describe("partial object patches at project scope", () => {
  it("completes a writing style field patch from the target's effective value", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const member = {
      id: projectId,
      environmentId,
      physicalProjectKey: "laptop:/repo",
      environmentLabel: "Laptop",
      title: "fleet",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Keep it short.",
            followChangeRequestTemplates: false,
          },
        },
      },
    };
    const plan = planScopedSettingsPatch(
      {
        kind: "project",
        group: {} as never,
        environmentId: null,
        label: "fleet",
        members: [member as never],
        environmentIds: [environmentId],
      },
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings,
            environment: { capabilities: { projectSettingsOverrides: true } },
          },
        },
      ],
      { sourceControlWritingStyle: { customInstructions: "Be terse." } },
    );
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom",
            customInstructions: "Be terse.",
            followChangeRequestTemplates: false,
          },
        },
      },
    });
  });
});

it("routes legacy model preference keys exclusively to the selected environment", () => {
  const patch = {
    favorites: [{ provider: ProviderInstanceId.make("codex"), model: "sol" }],
    providerModelPreferences: {},
  };
  const plan = planScopedSettingsPatch(named, environments, patch);
  expect(plan.clientPatch).toEqual({});
  expect(plan.hasClientWrite).toBe(false);
  expect(plan.serverWrites).toEqual([
    {
      environmentId: server.environmentId,
      label: server.label,
      previous: expect.anything(),
      patch,
    },
  ]);
});

describe("environments that cannot store a setting", () => {
  it.each([
    ["environment", all],
    ["project", project],
  ] as const)("excludes unsupported environments from %s reads and writes", (_label, scope) => {
    const enabledLaptop = environment("Laptop", {
      settings: {
        defaultAutoPull: true,
        projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } },
      },
    });
    const outdatedServer = {
      ...server,
      unsupportedSettingKeys: new Set(["defaultAutoPull"]),
    };
    const pair = [enabledLaptop, outdatedServer];
    const targets = resolveScopedSettingsTargets(scope, pair);
    expect(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(false);
    expect(
      scopedDisplaySettings(
        targets.find(({ environmentId }) => environmentId === server.environmentId)!,
        targets,
      ).defaultAutoPull,
    ).toBe(true);
    if (scope.kind === "project") {
      expect(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("project");
    }
    const plan = planScopedSettingsPatch(scope, pair, {
      defaultAutoPull: false,
      branchNamePrefix: "feat",
    });
    expect(
      plan.serverWrites
        .map(({ environmentId, patch }) => ({ environmentId, patch }))
        .sort((a, b) => a.environmentId.localeCompare(b.environmentId)),
    ).toEqual([
      {
        environmentId: laptop.environmentId,
        patch:
          scope.kind === "project"
            ? {
                projectSettingsOverrides: {
                  [laptopProjectId]: { defaultAutoPull: false, branchNamePrefix: "feat" },
                },
              }
            : { defaultAutoPull: false, branchNamePrefix: "feat" },
      },
      {
        environmentId: server.environmentId,
        patch:
          scope.kind === "project"
            ? { projectSettingsOverrides: { [projectId]: { branchNamePrefix: "feat" } } }
            : { branchNamePrefix: "feat" },
      },
    ]);
    const unsupported = planScopedSettingsPatch(scope, [outdatedServer], { defaultAutoPull: true });
    expect(unsupported.serverWrites).toEqual([]);
    expect(unsupported.unavailableReason).toBe("Update T3 Code on Server to use this setting.");
    expect(
      planScopedSettingsPatch(
        scope,
        [
          {
            ...server,
            unsupportedSettingKeys: resolveUnsupportedSettingKeys(["branchNamePrefix"], undefined),
          },
        ],
        { defaultAutoPull: true },
      ).serverWrites,
    ).toEqual([]);
  });

  it.each([
    {
      name: "writing style",
      scope: named,
      patch: { sourceControlWritingStyle: { mode: "custom", followChangeRequestTemplates: false } },
      accepted: { sourceControlWritingStyle: { mode: "custom" } },
      retry: { sourceControlWritingStyle: { customInstructions: "Keep it short." } },
    },
    {
      name: "storage cleanup",
      scope: named,
      patch: { storageCleanup: { logsAfterDays: 7, browserArtifactsAfterDays: 3 } },
      accepted: { storageCleanup: { logsAfterDays: 7 } },
      retry: { storageCleanup: { logsAfterDays: 14 } },
    },
    {
      name: "project worktree cleanup",
      scope: checkout,
      patch: {
        worktreeCleanup: {
          mode: "custom",
          rules: { worktreeOnDelete: true, worktreeSettledAfterDays: 3 },
        },
      },
      accepted: { worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } } },
      retry: { worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: false } } },
    },
  ] as const)(
    "keeps supported $name fields writable after a sibling is dropped",
    async ({ scope, patch, accepted, retry }) => {
      const original =
        scope.kind === "checkout"
          ? environment("Server", {
              settings: {
                projectSettingsOverrides: {
                  [projectId]: {
                    worktreeCleanup: {
                      mode: "custom",
                      rules: resolveWorktreeCleanup(DEFAULT_SERVER_SETTINGS, null),
                    },
                  },
                },
              },
            })
          : server;
      const plan = planScopedSettingsPatch(scope, [original], patch);
      const acceptedWrite = planScopedSettingsPatch(scope, [original], accepted).serverWrites[0]!;
      const saved = applyServerSettingsPatch(acceptedWrite.previous, acceptedWrite.patch);
      const result = await persistScopedSettingsPatch(
        plan,
        async () => ({ _tag: "Success", value: saved }),
        vi.fn(),
      );
      const learned = {
        ...server,
        serverConfig: { ...server.serverConfig!, settings: saved },
        unsupportedSettingKeys: resolveUnsupportedSettingKeys(
          undefined,
          new Set(result.failedEnvironments.flatMap(({ droppedKeys }) => droppedKeys)),
        ),
      };
      const next = planScopedSettingsPatch(scope, [learned], retry);
      expect(next.unavailableReason).toBeNull();
      expect(next.serverWrites).toMatchObject([
        {
          environmentId: server.environmentId,
          patch:
            scope.kind === "checkout"
              ? { projectSettingsOverrides: { [projectId]: retry } }
              : retry,
        },
      ]);
    },
  );
});

describe("model selection patches at project scope", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const saved = {
    instanceId: codex,
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const customized = environment("Server", {
    settings: {
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: saved,
          sourceControlWriterModelSelection: saved,
          reviewGuideModelSelection: saved,
          textGenerationModelSelection: saved,
        },
      },
    },
  });

  it("replaces old options when changing model selections", () => {
    const plan = planScopedSettingsPatch(checkout, [customized], {
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
    expect(plan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]).toEqual({
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
  });

  it("completes partial text-generation selections without retaining old options", () => {
    const modelPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { model: "gpt-5.6-mini" },
    });
    expect(
      modelPlan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]
        ?.textGenerationModelSelection,
    ).toEqual({ instanceId: codex, model: "gpt-5.6-mini" });

    const options = [{ id: "reasoningEffort", value: "low" }];
    const optionsPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { options },
    });
    expect(
      optionsPlan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]
        ?.textGenerationModelSelection,
    ).toEqual({ ...saved, options });
  });
});
