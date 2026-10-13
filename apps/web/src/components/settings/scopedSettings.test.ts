import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  listProjectOverrides,
  createScopedSettingsWriter,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

const decodeSettings = Schema.decodeSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);

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

function scopedWriter(initial = server.serverConfig!.settings) {
  let stored = initial;
  let snapshot: ServerSettings | null = initial;
  const responses: ServerSettings[] = [];
  const write = createScopedSettingsWriter();
  const read = vi.fn<Parameters<typeof write>[2]>(async () => ({
    _tag: "Success",
    value: stored,
  }));
  const persistClient = vi.fn();
  const commit = async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
    stored = applyServerSettingsPatch(stored, input.patch);
    responses.push(stored);
    return { _tag: "Success" as const, value: stored };
  };
  const persist = vi.fn(commit);
  const run = (planner: Parameters<typeof write>[1]) =>
    write(
      [environment("Server", { settings: snapshot ?? initial })],
      planner,
      read,
      persist,
      persistClient,
    );
  const edit = (patch: ServerSettingsPatch) =>
    run((current) => planScopedSettingsPatch(checkout, current, patch));
  const clear = (keys: Parameters<typeof planScopedSettingsClear>[2]) =>
    run((current) => planScopedSettingsClear(checkout, current, keys));
  return {
    run,
    edit,
    clear,
    read,
    persistClient,
    persist,
    commit,
    responses,
    stored: () => stored,
    push: (settings: ServerSettings | null) => {
      snapshot = settings;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function configPush(settings: ServerSettings) {
  return decodeSettings(encodeSettings(settings));
}

describe("queued scoped settings writes", () => {
  it("preserves another client's edit after a coalesced toggle cycle", async () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: false } },
    });
    const writes = scopedWriter(initial);
    await writes.edit({ defaultAutoPull: true });
    await writes.edit({ defaultAutoPull: false });
    writes.push(configPush(writes.stored()));
    const other = await writes.commit({
      input: { patch: { projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } } } },
    });
    writes.push(configPush(other.value));
    await writes.edit({ defaultThreadEnvMode: "local" });
    expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      defaultThreadEnvMode: "local",
    });
    expect(writes.stored()).toEqual(writes.responses.at(-1));
  });

  it.each(["reset", "toggle"])(
    "keeps a rapid %s when an older matching push arrives before its response",
    async (operation) => {
      const writes = scopedWriter();
      await writes.edit(
        operation === "reset" ? { removeAgentCreditsOnMerge: true } : { defaultAutoPull: true },
      );
      await writes.edit({ defaultAutoPull: operation === "reset" });
      const [earlier, intermediate] = writes.responses;
      writes.persist.mockImplementationOnce(async (request) => {
        writes.push(configPush(earlier!));
        return writes.commit(request);
      });
      if (operation === "reset") await writes.clear(["defaultAutoPull"]);
      else await writes.edit({ defaultAutoPull: true });
      writes.push(configPush(intermediate!));
      await writes.edit({ defaultThreadEnvMode: "local" });
      expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
        ...(operation === "reset"
          ? { removeAgentCreditsOnMerge: true }
          : { defaultAutoPull: true }),
        defaultThreadEnvMode: "local",
      });
      expect(writes.stored()).toEqual(writes.responses.at(-1));
      writes.push(configPush(writes.stored()));
    },
  );

  it.each(["edit", "reset"])(
    "accepts a batched acknowledgement of an %s that includes another writer's fields",
    async (operation) => {
      const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        projectSettingsOverrides: {
          [projectId]: {
            defaultAutoPull: true,
            ...(operation === "reset" ? { removeAgentCreditsOnMerge: true } : {}),
          },
        },
      });
      const writes = scopedWriter(initial);
      writes.persist.mockImplementationOnce(async (request) => {
        const result = await writes.commit(request);
        const newer = await writes.commit({
          input: {
            patch: {
              projectSettingsOverrides: {
                [projectId]: {
                  ...result.value.projectSettingsOverrides[projectId],
                  defaultThreadEnvMode: "local",
                },
              },
            },
          },
        });
        writes.push(configPush(newer.value));
        return result;
      });
      if (operation === "reset") await writes.clear(["removeAgentCreditsOnMerge"]);
      else await writes.edit({ removeAgentCreditsOnMerge: true });
      await writes.edit({ defaultAutoPull: false });
      expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
        defaultAutoPull: false,
        defaultThreadEnvMode: "local",
        ...(operation === "edit" ? { removeAgentCreditsOnMerge: true } : {}),
      });
      expect(writes.stored()).toEqual(writes.responses.at(-1));
    },
  );

  it("rebases queued edits on the response after an unrelated push during the save", async () => {
    const writes = scopedWriter();
    writes.persist.mockImplementationOnce(async (request) => {
      const external = await writes.commit({
        input: { patch: { enableProviderUpdateChecks: false } },
      });
      writes.push(configPush(external.value));
      return writes.commit(request);
    });
    await Promise.all([
      writes.edit({ defaultAutoPull: true }),
      writes.edit({ removeAgentCreditsOnMerge: true }),
    ]);
    expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      removeAgentCreditsOnMerge: true,
    });
    expect(writes.stored()).toEqual(writes.responses.at(-1));
    expect(writes.stored().enableProviderUpdateChecks).toBe(false);
  });

  it("respects an external reset after acknowledgement but before the response arrives", async () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    const writes = scopedWriter(initial);
    writes.persist.mockImplementationOnce(async (request) => {
      const result = await writes.commit(request);
      writes.push(configPush(result.value));
      const reset = await writes.commit({
        input: { patch: { projectSettingsOverrides: initial.projectSettingsOverrides } },
      });
      writes.push(configPush(reset.value));
      return result;
    });
    await Promise.all([
      writes.edit({ removeAgentCreditsOnMerge: true }),
      writes.edit({ defaultThreadEnvMode: "local" }),
    ]);
    expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      defaultThreadEnvMode: "local",
    });
    expect(writes.stored()).toEqual(writes.responses.at(-1));
    writes.push(configPush(writes.stored()));
  });

  it("preserves a completed save while the config push is still pending", async () => {
    const writes = scopedWriter();
    await writes.edit({ defaultAutoPull: true });
    await writes.edit({ removeAgentCreditsOnMerge: true });
    expect(writes.responses[1]?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      removeAgentCreditsOnMerge: true,
    });
    expect(writes.stored()).toEqual(writes.responses[1]);
  });

  it.each(["failure", "rejection"])("continues after a fresh settings read %s", async (failure) => {
    const writes = scopedWriter();
    writes.read.mockImplementationOnce(async () => {
      const error = new Error("Disconnected");
      if (failure === "rejection") throw error;
      return { _tag: "Failure", cause: Cause.fail(error) };
    });
    const results = await Promise.all([
      writes.edit({ defaultAutoPull: true }),
      writes.edit({ removeAgentCreditsOnMerge: true }),
    ]);
    expect(results[0]?.failedEnvironments[0]?.message).toBe("Disconnected");
    expect(results[1]?.savedEnvironmentCount).toBe(1);
    expect(writes.persist).toHaveBeenCalledTimes(1);
    expect(writes.stored().projectSettingsOverrides[projectId]).toEqual({
      removeAgentCreditsOnMerge: true,
    });
  });

  it("persists client preferences immediately while a server save is pending", async () => {
    const writes = scopedWriter();
    const started = deferred();
    const release = deferred();
    writes.persist.mockImplementationOnce(async (request) => {
      started.resolve();
      await release.promise;
      return writes.commit(request);
    });
    const first = writes.edit({ defaultAutoPull: true });
    await started.promise;
    await writes.run((current) =>
      planScopedSettingsPatch(checkout, current, { diffIgnoreWhitespace: false }),
    );
    expect(writes.persistClient).toHaveBeenCalledExactlyOnceWith({
      diffIgnoreWhitespace: false,
    });
    expect(writes.read).toHaveBeenCalledTimes(1);
    release.resolve();
    await first;
  });

  it("ignores an intermediate config push until it catches up with the latest save", async () => {
    const writes = scopedWriter();
    await writes.edit({ defaultAutoPull: true });
    await writes.edit({ removeAgentCreditsOnMerge: true });
    writes.push(configPush(writes.responses[0]!));
    await writes.edit({ defaultThreadEnvMode: "local" });
    expect(writes.responses[2]?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      removeAgentCreditsOnMerge: true,
      defaultThreadEnvMode: "local",
    });
    expect(writes.stored()).toEqual(writes.responses[2]);
  });

  it("uses fresh server settings after the config push catches up", async () => {
    const writes = scopedWriter();
    await writes.edit({ defaultAutoPull: true });
    writes.push(configPush(writes.stored()));
    await writes.edit({ removeAgentCreditsOnMerge: true });
    const external = await writes.commit({
      input: {
        patch: {
          projectSettingsOverrides: { [projectId]: { defaultAutoPull: false } },
        },
      },
    });
    writes.push(configPush(external.value));
    await writes.edit({ defaultThreadEnvMode: "local" });
    expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: false,
      defaultThreadEnvMode: "local",
    });
    expect(writes.stored()).toEqual(writes.responses.at(-1));
  });

  it("does not restore another client's reset to an earlier snapshot", async () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    const writes = scopedWriter(initial);
    await writes.edit({ removeAgentCreditsOnMerge: true });
    writes.push(configPush(writes.stored()));
    const reset = await writes.commit({
      input: {
        patch: {
          projectSettingsOverrides: initial.projectSettingsOverrides,
        },
      },
    });
    writes.push(configPush(reset.value));
    await writes.edit({ defaultThreadEnvMode: "local" });
    expect(writes.responses.at(-1)?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      defaultThreadEnvMode: "local",
    });
    expect(writes.stored()).toEqual(writes.responses.at(-1));
  });

  it.each([project, checkout])(
    "preserves both overrides from rapid edits at $kind scope",
    async (scope) => {
      const writes = scopedWriter();
      const started = deferred();
      const release = deferred();
      writes.persist.mockImplementationOnce(async (request) => {
        started.resolve();
        await release.promise;
        return writes.commit(request);
      });
      const first = writes.run((current) =>
        planScopedSettingsPatch(scope, current, { defaultAutoPull: true }),
      );
      const second = writes.run((current) =>
        planScopedSettingsPatch(scope, current, { removeAgentCreditsOnMerge: true }),
      );
      await started.promise;
      expect(writes.persist).toHaveBeenCalledTimes(1);
      expect(writes.read).toHaveBeenCalledTimes(1);
      release.resolve();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.savedEnvironmentCount)).toEqual([1, 1]);
      expect(writes.responses[0]?.projectSettingsOverrides[projectId]).toEqual({
        defaultAutoPull: true,
      });
      expect(writes.responses[1]?.projectSettingsOverrides[projectId]).toEqual({
        defaultAutoPull: true,
        removeAgentCreditsOnMerge: true,
      });
      expect(writes.stored()).toEqual(writes.responses[1]);
      expect(writes.read).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps a queued reset from erasing an earlier edit", async () => {
    const writes = scopedWriter({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    await Promise.all([
      writes.edit({ removeAgentCreditsOnMerge: true }),
      writes.clear(["defaultAutoPull"]),
    ]);
    expect(writes.responses[0]?.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      removeAgentCreditsOnMerge: true,
    });
    expect(writes.responses[1]?.projectSettingsOverrides[projectId]).toEqual({
      removeAgentCreditsOnMerge: true,
    });
    expect(writes.stored()).toEqual(writes.responses[1]);
  });

  it("keeps a queued edit from restoring a reset override", async () => {
    const writes = scopedWriter({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    await Promise.all([
      writes.clear(["defaultAutoPull"]),
      writes.edit({ removeAgentCreditsOnMerge: true }),
    ]);
    expect(writes.responses[0]?.projectSettingsOverrides[projectId]).toBeUndefined();
    expect(writes.responses[1]?.projectSettingsOverrides[projectId]).toEqual({
      removeAgentCreditsOnMerge: true,
    });
    expect(writes.stored()).toEqual(writes.responses[1]);
  });

  it("rebases the environment chain popover's reset on an earlier project edit", async () => {
    const writes = scopedWriter({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    await Promise.all([
      writes.edit({ removeAgentCreditsOnMerge: true }),
      writes.run((current) =>
        planProjectOverridesClear(
          current,
          [{ environmentId: server.environmentId, projectId }],
          ["defaultAutoPull"],
        ),
      ),
    ]);
    expect(writes.responses[1]?.projectSettingsOverrides[projectId]).toEqual({
      removeAgentCreditsOnMerge: true,
    });
    expect(writes.stored()).toEqual(writes.responses[1]);
  });

  it("preserves earlier edits to object-valued overrides", async () => {
    const writes = scopedWriter();
    await Promise.all([
      writes.edit({ sourceControlWritingStyle: { customInstructions: "Keep it brief." } }),
      writes.edit({ sourceControlWritingStyle: { followChangeRequestTemplates: false } }),
    ]);
    expect(writes.responses[1]?.projectSettingsOverrides[projectId]).toEqual({
      sourceControlWritingStyle: {
        ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
        customInstructions: "Keep it brief.",
        followChangeRequestTemplates: false,
      },
    });
    expect(writes.stored()).toEqual(writes.responses[1]);
  });

  it.each(["failure", "rejection"])(
    "continues after a first save %s without applying the failed edit",
    async (failure) => {
      const initial = {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" as const } },
      };
      const writes = scopedWriter(initial);
      const persist = vi.fn(async (request: Parameters<typeof writes.commit>[0]) => {
        if (persist.mock.calls.length === 1) {
          const error = new Error("Save failed");
          if (failure === "rejection") throw error;
          return { _tag: "Failure" as const, cause: Cause.fail(error) };
        }
        return writes.commit(request);
      });
      const write = createScopedSettingsWriter();
      const edit = (patch: ServerSettingsPatch) =>
        write(
          [environment("Server", { settings: initial })],
          (current) => planScopedSettingsPatch(checkout, current, patch),
          writes.read,
          persist,
          vi.fn(),
        );
      const results = await Promise.all([
        edit({ defaultAutoPull: true }),
        edit({ removeAgentCreditsOnMerge: true }),
      ]);
      expect(results[0]?.failedEnvironments[0]?.message).toBe("Save failed");
      expect(results[1]?.savedEnvironmentCount).toBe(1);
      expect(writes.responses[0]?.projectSettingsOverrides[projectId]).toEqual({
        defaultThreadEnvMode: "local",
        removeAgentCreditsOnMerge: true,
      });
      expect(writes.stored()).toEqual(writes.responses[0]);
    },
  );

  it("does not block another environment while one save is pending", async () => {
    const write = createScopedSettingsWriter();
    const started = deferred();
    const release = deferred();
    const saved = new Map<EnvironmentId, ServerSettings>();
    const persist = async (request: {
      environmentId: EnvironmentId;
      input: { patch: ServerSettingsPatch };
    }) => {
      if (request.environmentId === server.environmentId) {
        started.resolve();
        await release.promise;
      }
      const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, request.input.patch);
      saved.set(request.environmentId, settings);
      return { _tag: "Success" as const, value: settings };
    };
    const first = write(
      [server],
      (current) => planScopedSettingsPatch(named, current, { defaultAutoPull: true }),
      async () => ({ _tag: "Success", value: DEFAULT_SERVER_SETTINGS }),
      persist,
      vi.fn(),
    );
    await started.promise;
    const other = await write(
      [laptop],
      (current) => planScopedSettingsPatch(all, current, { defaultAutoPull: true }),
      async () => ({ _tag: "Success", value: DEFAULT_SERVER_SETTINGS }),
      persist,
      vi.fn(),
    );
    expect(other.savedEnvironmentCount).toBe(1);
    expect(saved.get(laptop.environmentId)?.defaultAutoPull).toBe(true);
    expect(saved.has(server.environmentId)).toBe(false);
    release.resolve();
    await first;
    expect(saved.get(server.environmentId)?.defaultAutoPull).toBe(true);
  });
});

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
        worktreeOnDelete: false,
        worktreeOnMerge: true,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
      {
        worktreeAfterDays: null,
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
        patch: {
          projectSettingsOverrides: {
            [projectId]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
          },
        },
      },
      {
        environmentId: laptop.environmentId,
        label: laptop.label,
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
    expect(plan.serverWrites.map((write) => write.patch.projectSettingsOverrides)).toEqual([
      {
        [projectId]: {
          defaultAutoPull: true,
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 8,
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
    { environmentId: server.environmentId, label: server.label, patch },
  ]);
});
