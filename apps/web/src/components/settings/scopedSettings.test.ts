import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  persistScopedSettingsPatch,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
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
        : { settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings } },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({ scope: "all" }, [], environments);
const device = resolveSettingsScope({ scope: "device" }, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
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
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member],
  memberProjectRefs: [{ environmentId: server.environmentId, projectId }],
  groupedProjectCount: 1,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label],
};

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
});

describe("scoped settings writes", () => {
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

  it("persists only client keys for this device, including patches that contain server keys", async () => {
    const persistServer = vi.fn();
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(device, environments, {
        diffIgnoreWhitespace: false,
        enableProviderUpdateChecks: false,
      }),
      persistServer,
      persistClient,
    );
    expect(persistClient).toHaveBeenCalledExactlyOnceWith({ diffIgnoreWhitespace: false });
    expect(persistServer).not.toHaveBeenCalled();
  });

  it("rejects a client preference while an environment is selected", () => {
    expect(
      planScopedSettingsPatch(named, environments, { diffIgnoreWhitespace: false }),
    ).toMatchObject({
      clientPatch: {},
      hasClientWrite: false,
      serverWrites: [],
      unavailableReason: "Select This device to change this preference.",
    });
  });

  it.each([
    { project: group.projectKey },
    { project: group.projectKey, checkout: member.physicalProjectKey },
    { machine: "removed" },
  ])("never substitutes an environment-default write for project or invalid scope %j", (search) => {
    const scope = resolveSettingsScope(search, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({ scope: "all" }, [], selected);
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      persistServer,
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });
});

describe("scoped settings mixed values", () => {
  it("compares only requested settings and ignores disconnected configurations", () => {
    const changed = environment("Changed", { settings: { enableAgentBrowserAccess: false } });
    const disconnected = environment("Disconnected", {
      connected: false,
      settings: { enableProviderUpdateChecks: false },
    });
    expect(scopedSettingsAreMixed([laptop, changed], ["enableAgentBrowserAccess"])).toBe(true);
    expect(
      scopedSettingsAreMixed([laptop, changed, disconnected], ["enableProviderUpdateChecks"]),
    ).toBe(false);
    expect(scopedSettingsAreMixed([offline, loading], ["enableAgentBrowserAccess"])).toBe(false);
  });

  it("treats independently decoded equal nested settings as the same value", () => {
    const first = environment("First", {
      settings: {
        sourceControlWritingStyle: {
          ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
          mode: "custom",
          customInstructions: "Use plain language",
        },
      },
    });
    const second = environment("Second", {
      settings: {
        sourceControlWritingStyle: {
          ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
          mode: "custom",
          customInstructions: "Use plain language",
        },
      },
    });
    expect(scopedSettingsAreMixed([first, second], ["sourceControlWritingStyle"])).toBe(false);
  });
});
