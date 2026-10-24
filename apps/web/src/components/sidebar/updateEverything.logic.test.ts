import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createUpdatePlanItemResolver,
  resolveUpdatePlanItem,
  retryExecutionPlan,
} from "./updateEverythingExecution";
import {
  runUpdatePlan,
  type UpdateExecutionPlan,
  type UpdatePlanStore,
  type UpdatePlanItem,
} from "./updateEverythingPlan";

import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateOptions,
  updateItemKey,
  type UpdateEverythingMachine,
  type UpdateOptionMachine,
} from "./updateEverything.logic";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "on the nightly channel"],
      ["offline", "not connected"],
      ["never-connected", "not connected"],
      ["no-scope", "no permission"],
      ["busy", "already updating"],
      ["manual", "needs a manual update"],
    ]);
  });
});

function optionMachine(
  id: string,
  overrides: Partial<UpdateOptionMachine> = {},
): UpdateOptionMachine {
  return {
    ...machine(id, "0.0.1", "boot-service"),
    enabled: true,
    sessionReady: true,
    sessionInitialized: true,
    connectionPhase: "connected",
    providers: [],
    canManageProviders: true,
    ...overrides,
  };
}

function provider(driver: string, instance: string): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(instance),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g provider",
      canUpdate: true,
      checkedAt: "2026-10-22T00:00:00.000Z",
      message: null,
    },
  };
}

it.each([true, false, undefined])(
  "saves honest provider intent with canInstallVersion=%s",
  (canInstallVersion) => {
    const selected = provider("claudeAgent", "selected");
    const remote = optionMachine("remote", {
      providers: [
        {
          ...selected,
          versionAdvisory: {
            ...selected.versionAdvisory!,
            ...(canInstallVersion === undefined ? {} : { canInstallVersion }),
          },
        },
      ],
    });
    const { devices, operations } = collectUpdateOptions({
      primaryEnvironmentId: null,
      machines: [remote],
      localVersion: null,
      npmPublished: true,
    });
    const row = devices.flatMap((device) => device.items).find((item) => item.kind === "provider")!;
    expect(row.disabledReason).toBeNull();
    expect(operations.get(row.key)?.targetVersion).toBe("latest");
    expect(row.toVersion).toBeNull();
    expect(row.note).toBe("Installer chooses the latest version");
  },
);

it.each(["latest", "1.1.0"])(
  "keeps saved %s intent when the available version changes",
  (targetVersion) => {
    const selected = provider("claudeAgent", "selected");
    const remote = optionMachine("remote", { providers: [selected] });
    const item = [
      ...collectUpdateOptions({
        primaryEnvironmentId: null,
        machines: [remote],
        localVersion: null,
        npmPublished: true,
      }).operations.values(),
    ].find((item) => item.kind === "provider")!;
    const changed = {
      ...selected,
      versionAdvisory: {
        ...selected.versionAdvisory!,
        latestVersion: "1.2.0",
        canInstallVersion: false,
      },
    };
    const resolve = (provider: ServerProvider, recovering = false) =>
      resolveUpdatePlanItem(
        { ready: true, machines: [{ ...remote, providers: [provider] }] },
        { ...item, targetVersion },
        recovering,
      );
    expect.soft(resolve(changed).status).toBe(targetVersion === "latest" ? "ready" : "skipped");
    expect(resolve({ ...changed, version: "1.2.0" }).status).toBe("skipped");
    expect(resolve({ ...changed, version: "1.2.0" }, true).status).toBe("unknown");
    const current: ServerProvider = {
      ...changed,
      version: "1.2.0",
      versionAdvisory: { ...changed.versionAdvisory, status: "current", currentVersion: "1.2.0" },
    };
    expect(resolve(current, true).status).toBe(targetVersion === "latest" ? "done" : "unknown");
    expect(
      resolve(
        {
          ...current,
          version: "1.3.0",
          versionAdvisory: { ...current.versionAdvisory!, currentVersion: "1.3.0" },
        },
        true,
      ).status,
    ).toBe(targetVersion === "latest" ? "done" : "unknown");
    expect(resolve({ ...current, version: "1.3.0" }, true).status).toBe("unknown");
    expect(resolve({ ...current, enabled: false }, true).status).toBe("unknown");
    expect(
      resolve(
        {
          ...current,
          updateState: {
            status: "running",
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        },
        true,
      ).status,
    ).toBe("wait");
  },
);

it("groups primary and local WSL under one app item and keeps exact provider identities", () => {
  const primary = optionMachine("primary", {
    hostedByThisApp: true,
    providers: [provider("codex", "same")],
  });
  const wsl = optionMachine("wsl", {
    hostedByThisApp: true,
    providers: [provider("claudeAgent", "same")],
  });
  const { devices, operations } = collectUpdateOptions({
    primaryEnvironmentId: primary.environmentId,
    machines: [primary, wsl],
    localVersion: "0.0.2",
    npmPublished: true,
  });
  expect(devices).toHaveLength(1);
  expect(devices[0]?.items.map((item) => item.kind)).toEqual(["app", "provider", "provider"]);
  expect(new Set(operations.keys()).size).toBe(3);
  const app = devices[0]!.items[0]!;
  expect(app.restarts.map((machine) => machine.environmentId)).toEqual(["primary", "wsl"]);
  expect(updateItemKey("provider", primary.environmentId, "a:b", "c")).not.toBe(
    updateItemKey("provider", primary.environmentId, "a", "b:c"),
  );
});

it("does not offer executable items after identity changes or provider permission loss", () => {
  const remote = optionMachine("remote", {
    providers: [provider("codex", "instance")],
    canManageProviders: false,
  });
  const replaced = {
    ...remote,
    serverConfig: machine("replacement", "0.0.1", "boot-service").serverConfig,
  };
  const { devices, operations } = collectUpdateOptions({
    primaryEnvironmentId: null,
    machines: [replaced],
    localVersion: "0.0.2",
    npmPublished: true,
  });
  expect(operations.size).toBe(0);
  expect(devices[0]?.items.every((item) => item.disabledReason !== null)).toBe(true);
});

it("leaves tools selectable when T3 is unchecked and excludes newly disabled items", () => {
  const remote = optionMachine("remote", { providers: [provider("codex", "instance")] });
  const before = collectUpdateOptions({
    primaryEnvironmentId: null,
    machines: [remote],
    localVersion: "0.0.2",
    npmPublished: true,
  });
  const selection = new Set(
    before.devices[0]!.items.filter((item) => item.kind === "provider").map((item) => item.key),
  );
  expect([...selection].map((key) => before.operations.get(key)?.kind)).toEqual(["provider"]);
  const after = collectUpdateOptions({
    primaryEnvironmentId: null,
    machines: [{ ...remote, canManageProviders: false }],
    localVersion: "0.0.2",
    npmPublished: true,
  });
  expect([...selection].flatMap((key) => (after.operations.has(key) ? [key] : []))).toEqual([]);
});

describe("collectRestartingMachines", () => {
  it("lists updated servers, and this app's servers only when it installs", () => {
    const withContinuation = (
      id: string,
      overrides: Partial<UpdateEverythingMachine> = {},
      enabled = false,
    ) => {
      const base = machine(id, "0.0.40", "boot-service", overrides);
      return {
        ...base,
        serverConfig: {
          environment: {
            ...base.serverConfig!.environment,
            capabilities: {
              ...base.serverConfig!.environment.capabilities,
              threadRestartContinuation: true,
            },
          },
          settings: { continueThreadsAfterServerUpdate: enabled },
        },
      };
    };
    const machines = [
      withContinuation("this-app", { hostedByThisApp: true }, true),
      withContinuation("alvin", {}, true),
      withContinuation("opted-out", {}, false),
      machine("old", "0.0.40", "boot-service"),
      withContinuation("providers-only"),
    ];
    const servers = ["alvin", "opted-out", "old"].map((id) => ({
      environmentId: EnvironmentId.make(id),
    }));

    expect(collectRestartingMachines(machines, servers, true)).toEqual([
      { environmentId: "this-app", continuesThreads: true },
      { environmentId: "alvin", continuesThreads: true },
      { environmentId: "opted-out", continuesThreads: false },
      { environmentId: "old", continuesThreads: false },
    ]);
    expect(
      collectRestartingMachines(machines, servers, false).map((entry) => entry.environmentId),
    ).toEqual(["alvin", "opted-out", "old"]);
  });
});

it("keeps a selected connecting remote pending after local recovery and dispatches it once connected", async () => {
  const remote = optionMachine("remote", { connected: false, connectionPhase: "connecting" });
  const selected = collectUpdateOptions({
    primaryEnvironmentId: null,
    machines: [{ ...remote, connected: true, connectionPhase: "connected" }],
    localVersion: "0.0.2",
    npmPublished: true,
  });
  const server = [...selected.operations.values()][0]!;
  let snapshot = { ready: true, machines: [remote] };
  let saved: UpdateExecutionPlan | null = {
    schemaVersion: 1,
    id: "plan",
    primaryEnvironmentId: null,
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "servers",
    pausedReason: null,
    items: [server],
  };
  const store: UpdatePlanStore = {
    read: async () => saved,
    change: async (update) => (saved = update(saved)),
  };
  const calls: string[] = [];
  const ports = {
    claimId: "renderer",
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: (item: typeof server, recovering: boolean) =>
      resolveUpdatePlanItem(snapshot, item, recovering),
    download: async () => true,
    maintenanceReady: () => true,
    waitForMaintenance: async () => {},
    countdown: async () => true,
    install: async () => true,
    execute: async (item: typeof server) => {
      calls.push(item.key);
      return { status: "done" as const };
    },
  };
  await runUpdatePlan(store, ports);
  expect(saved?.items[0]?.status).toBe("pending");
  expect(calls).toEqual([]);
  snapshot = {
    ready: true,
    machines: [{ ...remote, connected: true, connectionPhase: "connected" }],
  };
  await runUpdatePlan(store, ports);
  await runUpdatePlan(store, ports);
  expect(calls).toEqual([server.key]);
  expect(saved?.items[0]?.status).toBe("done");
});

it("reports a reconnect deadline and blocked authentication without substituting another environment", () => {
  const remote = optionMachine("remote");
  const item = [
    ...collectUpdateOptions({
      primaryEnvironmentId: null,
      machines: [remote],
      localVersion: "0.0.2",
      npmPublished: true,
    }).operations.values(),
  ][0]!;
  const connecting = { ...remote, connected: false, connectionPhase: "reconnecting" as const };
  expect(resolveUpdatePlanItem({ ready: true, machines: [connecting] }, item, false, true)).toEqual(
    { status: "skipped", message: "Connection did not return within one minute" },
  );
  expect(
    resolveUpdatePlanItem(
      {
        ready: true,
        machines: [{ ...connecting, connectionPhase: "error", sessionInitialized: false }],
      },
      item,
      false,
    ).status,
  ).toBe("skipped");
  expect(resolveUpdatePlanItem({ ready: false, machines: [] }, item, false).status).toBe("wait");
  expect(
    resolveUpdatePlanItem({ ready: true, machines: [optionMachine("replacement")] }, item, false)
      .status,
  ).toBe("skipped");
});

it("explicit retry keeps successful items, verifies ambiguous servers, and restores their deferred tools", () => {
  const machine = optionMachine("remote");
  const server = [
    ...collectUpdateOptions({
      primaryEnvironmentId: null,
      machines: [machine],
      localVersion: "0.0.2",
      npmPublished: true,
    }).operations.values(),
  ][0]!;
  const saved: UpdateExecutionPlan = {
    schemaVersion: 1,
    id: "plan",
    primaryEnvironmentId: null,
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "paused",
    pausedReason: "unknown",
    items: [
      { ...server, status: "unknown", claimId: "lost" },
      {
        ...server,
        key: "tools",
        kind: "provider",
        status: "skipped",
        message: "T3 update did not finish on this device",
      },
      { ...server, key: "success", status: "done" },
    ],
  };
  const retried = retryExecutionPlan(saved, "1.0.0", () => ({ status: "unknown" }));
  expect(retried.phase).toBe("servers");
  expect(retried.items.map((item) => item.status)).toEqual(["pending", "pending", "done"]);
  const updated = {
    ...machine,
    serverConfig: machine.serverConfig && {
      ...machine.serverConfig,
      environment: { ...machine.serverConfig.environment, serverVersion: server.targetVersion },
    },
  };
  expect(
    resolveUpdatePlanItem({ ready: true, machines: [updated] }, retried.items[0]!, false).status,
  ).toBe("ready");
  expect(
    retryExecutionPlan({ ...saved, pausedReason: "expired" }, "1.0.0", () => ({ status: "ready" })),
  ).toEqual({ ...saved, pausedReason: "expired" });
});

it("retry during reconnect keeps an ambiguous foreign claim paused until an explicit checked retry", async () => {
  const remote = optionMachine("remote", { connected: false, connectionPhase: "connecting" });
  const server = [
    ...collectUpdateOptions({
      primaryEnvironmentId: null,
      machines: [{ ...remote, connected: true, connectionPhase: "connected" }],
      localVersion: "0.0.2",
      npmPublished: true,
    }).operations.values(),
  ][0]!;
  let snapshot = { ready: true, machines: [remote] };
  let saved: UpdateExecutionPlan | null = {
    schemaVersion: 1,
    id: "retry-plan",
    primaryEnvironmentId: null,
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "paused",
    pausedReason: "unknown",
    items: [
      { ...server, status: "claimed", claimId: "lost-renderer" },
      { ...server, key: "tool", kind: "provider", environmentId: EnvironmentId.make("other") },
    ],
  };
  const store: UpdatePlanStore = {
    read: async () => saved,
    change: async (update) => (saved = update(saved)),
  };
  const resolver = (item: typeof server, recovering: boolean) =>
    item.kind === "provider"
      ? { status: "ready" as const }
      : resolveUpdatePlanItem(snapshot, item, recovering);
  const calls: string[] = [];
  let completeServer!: () => void;
  const serverFinished = new Promise<void>((resolve) => {
    completeServer = resolve;
  });
  let markStarted!: () => void;
  const serverStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const ports = {
    claimId: "same-new-renderer",
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: resolver,
    download: async () => true,
    maintenanceReady: () => true,
    waitForMaintenance: async () => {},
    countdown: async () => true,
    install: async () => true,
    execute: async (item: typeof server) => {
      calls.push(item.key);
      if (item.kind === "server") {
        markStarted();
        await serverFinished;
      }
      return { status: "done" as const };
    },
  };
  await store.change((plan) => plan && retryExecutionPlan(plan, "1.0.0", resolver));
  await runUpdatePlan(store, ports);
  expect(saved?.phase).toBe("paused");
  expect(saved?.items[0]?.claimId).toBe("lost-renderer");
  snapshot = {
    ready: true,
    machines: [{ ...remote, connected: true, connectionPhase: "connected" }],
  };
  await runUpdatePlan(store, ports);
  expect(saved?.phase).toBe("paused");
  expect(calls).toEqual([]);
  await store.change((plan) => plan && retryExecutionPlan(plan, "1.0.0", resolver));
  const running = runUpdatePlan(store, ports);
  await serverStarted;
  expect(calls).toEqual([server.key]);
  completeServer();
  await running;
  await runUpdatePlan(store, ports);
  expect(calls).toEqual([server.key, "tool"]);
  expect(saved?.phase).toBe("complete");
});

it.each(["checked", "startup-expired", "enrichment-expired"] as const)(
  "waits for the Cursor startup check and enrichment after restart: %s",
  async (outcome) => {
    vi.useFakeTimers();
    const checked = provider("cursor", "selected-cursor");
    const remote = optionMachine("remote", { providers: [checked] });
    const item = [
      ...collectUpdateOptions({
        primaryEnvironmentId: null,
        machines: [remote],
        localVersion: "0.0.2",
        npmPublished: true,
      }).operations.values(),
    ].find((item) => item.kind === "provider")!;
    const { versionAdvisory: _advisory, ...identity } = checked;
    const initial: ServerProvider = {
      ...identity,
      enabled: true,
      installed: true,
      version: null,
      auth: { status: "unknown" },
      status: "warning",
      message: "Checking Cursor SDK availability...",
    };
    let snapshot = { ready: true, machines: [{ ...remote, providers: [initial] }] };
    let saved: UpdateExecutionPlan | null = {
      schemaVersion: 1,
      id: "provider-restart",
      primaryEnvironmentId: null,
      sourceVersion: "1.0.0",
      createdAt: 0,
      phase: "providers",
      pausedReason: null,
      items: [item],
    };
    const store: UpdatePlanStore = {
      read: async () => saved,
      change: async (update) => (saved = update(saved)),
    };
    const calls: string[] = [];
    const ports = {
      claimId: "restarted-renderer",
      appVersion: "1.0.0",
      now: () => 0,
      ready: () => true,
      notAppliedVersion: () => null,
      resolve: (item: UpdatePlanItem, recovering: boolean) => resolver.resolve(item, recovering),
      download: async () => true,
      maintenanceReady: () => true,
      waitForMaintenance: async () => {},
      countdown: async () => true,
      install: async () => true,
      execute: async (item: UpdatePlanItem) => {
        calls.push(item.key);
        return { status: "done" as const };
      },
    };
    let deadlineRun: Promise<void> | undefined;
    const resolver = createUpdatePlanItemResolver(
      () => snapshot,
      () => {
        deadlineRun = runUpdatePlan(store, ports);
      },
    );
    try {
      await runUpdatePlan(store, ports);
      expect(saved?.items[0]?.status).toBe("pending");
      expect(calls).toEqual([]);
      if (outcome !== "startup-expired") {
        snapshot = { ready: true, machines: [{ ...remote, providers: [{ ...identity }] }] };
        await runUpdatePlan(store, ports);
        expect(saved?.items[0]?.status).toBe("pending");
        snapshot = {
          ready: true,
          machines: [
            {
              ...remote,
              providers: [
                {
                  ...checked,
                  versionAdvisory: {
                    ...checked.versionAdvisory!,
                    status: "unknown",
                    latestVersion: null,
                  },
                },
              ],
            },
          ],
        };
        await runUpdatePlan(store, ports);
        expect(saved?.items[0]?.status).toBe("pending");
        expect(calls).toEqual([]);
      }
      if (outcome !== "checked") {
        await vi.advanceTimersByTimeAsync(60_000);
        await deadlineRun;
        expect(saved?.items[0]?.status).toBe("skipped");
        expect(saved?.items[0]?.message).toBe(
          "Provider update check did not finish within one minute",
        );
        expect(saved?.phase).toBe("complete");
        expect(calls).toEqual([]);
        return;
      }
      snapshot = { ready: true, machines: [{ ...remote, providers: [...remote.providers] }] };
      await runUpdatePlan(store, ports);
      await runUpdatePlan(store, ports);
      expect(calls).toEqual([item.key]);
      expect(saved?.items[0]?.status).toBe("done");
    } finally {
      resolver.dispose();
      vi.useRealTimers();
    }
  },
);

it("bounds an unresolved provider check and preserves definite skips", () => {
  const checked = provider("cursor", "selected-cursor");
  const remote = optionMachine("remote", { providers: [checked] });
  const item = [
    ...collectUpdateOptions({
      primaryEnvironmentId: null,
      machines: [remote],
      localVersion: "0.0.2",
      npmPublished: true,
    }).operations.values(),
  ].find((item) => item.kind === "provider")!;
  const resolve = (providers: readonly ServerProvider[], expired = false, recovering = false) =>
    resolveUpdatePlanItem(
      { ready: true, machines: [{ ...remote, providers }] },
      item,
      recovering,
      expired,
    );
  const { versionAdvisory: _advisory, ...identity } = checked;
  const initial: ServerProvider = {
    ...identity,
    version: null,
    auth: { status: "unknown" },
    status: "warning",
  };
  expect(resolve([initial], true)).toEqual({
    status: "skipped",
    message: "Provider update check did not finish within one minute",
  });
  expect(resolve([initial], true, true).status).toBe("unknown");
  expect(resolve([{ ...checked, version: null, status: "error" }]).status).toBe("skipped");
  expect(resolve([]).status).toBe("skipped");
  expect(resolve([{ ...initial, enabled: false }]).status).toBe("skipped");
  expect(resolve([{ ...identity, version: "0.9.0" }]).status).toBe("skipped");
  expect(
    resolve([
      {
        ...checked,
        versionAdvisory: {
          ...checked.versionAdvisory!,
          canUpdate: false,
          updateCommand: null,
        },
      },
    ]).status,
  ).toBe("skipped");
});

it("keeps ON as the default and records explicit OFF apart from legacy continueThreads", () => {
  const local = optionMachine("local", { hostedByThisApp: true });
  const remote = optionMachine("remote");
  const machines = [local, remote].map((target) => ({
    ...target,
    serverConfig: {
      ...target.serverConfig!,
      environment: {
        ...target.serverConfig!.environment,
        capabilities: {
          ...target.serverConfig!.environment.capabilities,
          threadRestartContinuationControl: true,
        },
      },
    },
  }));
  const options = {
    canDisableLocalAutoResume: true,
    primaryEnvironmentId: local.environmentId,
    machines,
    localVersion: "0.0.2",
    npmPublished: true,
  };
  for (const autoResume of [undefined, true, false]) {
    const result = collectUpdateOptions({ ...options, autoResume });
    expect(result.operations.size).toBe(2);
    for (const operation of result.operations.values()) {
      expect(operation.autoResume).toBe(autoResume ?? true);
      expect(operation.continueThreads).toBe(false);
    }
  }
});

it("keeps legacy updates available on ON and refuses OFF without host proof", () => {
  const local = optionMachine("local", { hostedByThisApp: true });
  const remote = optionMachine("remote");
  const options = {
    primaryEnvironmentId: local.environmentId,
    machines: [local, remote],
    localVersion: "0.0.2",
    npmPublished: true,
  };
  expect(collectUpdateOptions(options).operations.size).toBe(2);
  const off = collectUpdateOptions({ ...options, autoResume: false });
  expect(off.operations.size).toBe(0);
  expect(
    off.devices
      .flatMap((device) => device.items)
      .every((item) => item.canDisableAutoResume === false),
  ).toBe(true);
});
