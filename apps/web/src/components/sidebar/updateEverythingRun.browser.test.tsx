import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopUpdateState,
  type ServerProvider,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, type Atom } from "effect/reactivity";
import { updateOptionsSnapshotAtom } from "./updateEverythingOptions";
import {
  describeUpdateCapsule,
  updateItemKey,
  type UpdateOptionMachine,
} from "./updateEverything.logic";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { APP_VERSION } from "~/branding";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { act, render } from "../../../test/render";
import {
  runUpdatePlan,
  type UpdateExecutionPlan,
  type UpdatePlanPorts,
} from "./updateEverythingPlan";
import { updatePlanStore } from "./updateEverythingPlanStore";
import {
  postponeUpdateRestart,
  startUpdatePlan,
  UpdateEverythingCoordinator,
  useUpdateEverythingRun,
} from "./updateEverythingRun";

const toast = vi.hoisted(() => vi.fn());
vi.mock(import("~/state/desktopUpdate"), () => ({
  useDesktopUpdateState: vi.fn<() => DesktopUpdateState | null>(() => null),
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

vi.mock(import("./updateEverythingPlan"), async (original) => ({
  ...(await original()),
  runUpdatePlan: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: vi.fn(),
}));

const { optionsSnapshotAtom } = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    optionsSnapshotAtom: Atom.make<Atom.Type<typeof updateOptionsSnapshotAtom>>({
      ready: true,
      primaryEnvironmentId: null,
      localEnvironmentDisabled: true,
      canDisableLocalAutoResume: false,
      machines: [],
    }),
  };
});
vi.mock(import("./updateEverythingOptions"), () => ({
  updateOptionsSnapshotAtom: optionsSnapshotAtom,
}));

vi.mock(import("./updateEverythingPlanStore"), async (original) => {
  const module = await original();
  const { randomUUID } = await import("~/lib/utils");
  const store = module.openUpdatePlanStore(`update-run-test-${randomUUID()}`);
  return { ...module, updatePlanStore: () => store };
});

function Progress() {
  const run = useUpdateEverythingRun();
  return (
    <output>
      {run?.machines
        .map((machine) => `${machine.label}: ${machine.result ?? "pending"}`)
        .join(", ")}
    </output>
  );
}

function RestartProgress({ now }: { now: number }) {
  const run = useUpdateEverythingRun();
  return (
    <output>{run && `${describeUpdateCapsule(run, [], null, now).label}: ${run.restartAt}`}</output>
  );
}

it.each(["connection", "desktop"] as const)(
  "does not read update storage for idle %s updates",
  async (source) => {
    const store = await updatePlanStore();
    await store.discard();
    const originalRead = store.read;
    using read = vi.spyOn(store, "read").mockResolvedValue(null);
    const runner = vi.mocked(runUpdatePlan).mockReset().mockResolvedValue(undefined);
    vi.mocked(useDesktopUpdateState).mockReset();
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <UpdateEverythingCoordinator />
      </RegistryContext.Provider>,
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    read.mockImplementation(originalRead).mockClear();
    using get = vi.spyOn(IDBObjectStore.prototype, "get");
    if (source === "connection") {
      await act(() => {
        appAtomRegistry.update(optionsSnapshotAtom, (snapshot) => ({ ...snapshot }));
      });
    } else {
      vi.mocked(useDesktopUpdateState).mockReturnValue({
        enabled: true,
        status: "downloading",
        channel: "latest",
        currentVersion: "1.0.0",
        hostArch: "x64",
        appArch: "x64",
        runningUnderArm64Translation: false,
        availableVersion: "1.0.1",
        downloadedVersion: null,
        releaseNotes: [],
        omittedReleaseCount: 0,
        downloadPercent: 50,
        checkedAt: null,
        message: null,
        errorContext: null,
        canRetry: false,
      });
      await screen.rerender(
        <RegistryContext.Provider value={appAtomRegistry}>
          <UpdateEverythingCoordinator />
        </RegistryContext.Provider>,
      );
    }
    expect(read).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    await act(() => window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    vi.mocked(useDesktopUpdateState).mockReset();
  },
);

it("keeps readiness wakes received before a plan is published", async () => {
  const store = await updatePlanStore();
  await store.discard();
  using _read = vi.spyOn(store, "read").mockResolvedValue(null);
  const runner = vi.mocked(runUpdatePlan).mockReset().mockResolvedValue(undefined);
  vi.mocked(useDesktopUpdateState).mockReset();
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UpdateEverythingCoordinator />
    </RegistryContext.Provider>,
  );
  await vi.waitFor(() => expect(runner).toHaveBeenCalled());
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  runner.mockClear().mockImplementationOnce(async () => {
    entered();
    await finished;
  });
  window.dispatchEvent(new Event("focus"));
  await started;
  try {
    await act(() => {
      appAtomRegistry.update(optionsSnapshotAtom, (snapshot) => ({ ...snapshot }));
    });
  } finally {
    finish();
  }
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
});

it("loads newly saved plans and resumes them when connections become ready", async () => {
  const store = await updatePlanStore();
  await store.discard();
  const snapshot = appAtomRegistry.get(updateOptionsSnapshotAtom);
  const actual =
    await vi.importActual<typeof import("./updateEverythingPlan")>("./updateEverythingPlan");
  const runner = vi
    .mocked(runUpdatePlan)
    .mockReset()
    .mockImplementation((store, ports) =>
      actual.runUpdatePlan(store, { ...ports, now: () => 1_000 }),
    );
  vi.mocked(useDesktopUpdateState).mockReset();
  try {
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <UpdateEverythingCoordinator />
        <Progress />
      </RegistryContext.Provider>,
    );
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    await act(() => {
      appAtomRegistry.update(optionsSnapshotAtom, (current) => ({ ...current, ready: false }));
    });
    await store.create({
      schemaVersion: 1,
      id: "readiness",
      primaryEnvironmentId: null,
      sourceVersion: APP_VERSION,
      createdAt: 1_000,
      phase: "servers",
      pausedReason: null,
      items: [
        {
          key: "server:remote",
          kind: "server",
          environmentId: EnvironmentId.make("remote"),
          label: "remote",
          fromVersion: "1.0.0",
          targetVersion: "1.0.1",
          driver: null,
          instanceId: null,
          continueThreads: false,
          status: "done",
          claimId: null,
          message: null,
        },
      ],
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent("remote: done");
    expect((await store.read())?.phase).toBe("servers");
    await act(() => {
      appAtomRegistry.update(optionsSnapshotAtom, (current) => ({ ...current, ready: true }));
    });
    await vi.waitFor(async () => expect((await store.read())?.phase).toBe("complete"));
  } finally {
    appAtomRegistry.update(optionsSnapshotAtom, () => snapshot);
    await store.discard();
  }
});

it("publishes committed device results while another update is still running", async () => {
  const store = await updatePlanStore();
  await store.discard();
  const plan: UpdateExecutionPlan = {
    schemaVersion: 1,
    id: "progress",
    primaryEnvironmentId: null,
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "providers",
    pausedReason: null,
    items: ["fast", "failed", "slow"].map((key) => ({
      key,
      kind: "provider",
      environmentId: EnvironmentId.make(key),
      label: key,
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
      driver: null,
      instanceId: null,
      continueThreads: false,
      status: "pending",
      claimId: null,
      message: null,
    })),
  };
  await store.create(plan);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runner = vi.mocked(runUpdatePlan).mockReset();
  runner.mockImplementationOnce(async () => {
    entered();
    await finished;
  });
  try {
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <UpdateEverythingCoordinator />
        <Progress />
      </RegistryContext.Provider>,
    );
    await started;
    expect(
      (await navigator.locks.query()).held?.some(
        (lock) => lock.name === `t3code-update-plan-owner:${runner.mock.calls[0]![1].claimId}`,
      ),
    ).toBe(true);
    let publishOld!: (plan: UpdateExecutionPlan) => void;
    const oldRead = new Promise<UpdateExecutionPlan>((resolve) => {
      publishOld = resolve;
    });
    using _read = vi.spyOn(store, "read").mockImplementationOnce(() => oldRead);
    await store.change((current) => current && { ...current, items: [...current.items] });
    await store.change(
      (current) =>
        current && {
          ...current,
          items: current.items.map((item) => ({
            ...item,
            status: item.key === "fast" ? "done" : item.key === "failed" ? "failed" : "claimed",
            message: item.key === "failed" ? "Install failed" : null,
          })),
        },
    );
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("fast: done, failed: failed, slow: pending");
    expect(runner).toHaveBeenCalledTimes(1);
    await act(async () => {
      publishOld(plan);
      await oldRead;
    });
    expect(screen.getByRole("status").element().textContent).toBe(
      "fast: done, failed: failed, slow: pending",
    );
  } finally {
    finish();
    await finished;
    await store.discard();
  }
});

it("tells the user when none of the chosen updates can start", async () => {
  toast.mockReset();
  await expect(startUpdatePlan(new Set(["gone"]), null, false)).resolves.toEqual({
    status: "empty",
  });
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "info", title: "No selected updates can start right now." }),
  );
  expect(await (await updatePlanStore()).read()).toBeNull();
});

it.each(["can-pin", "latest", "legacy-server", "legacy-plan"] as const)(
  "dispatches the saved provider target for %s updates",
  async (mode) => {
    const store = await updatePlanStore();
    await store.discard();
    const snapshot = appAtomRegistry.get(updateOptionsSnapshotAtom);
    const original = { ...snapshot };
    const provider: ServerProvider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("selected"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-23T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        canUpdate: true,
        ...(mode === "legacy-server" ? {} : { canInstallVersion: mode === "can-pin" }),
        updateCommand: "claude update",
        checkedAt: "2026-10-23T00:00:00.000Z",
        message: null,
      },
    };
    const machine: UpdateOptionMachine = {
      environmentId: EnvironmentId.make("remote"),
      label: "remote",
      hostedByThisApp: false,
      connected: true,
      enabled: true,
      canMaintain: false,
      canManageProviders: true,
      connectionPhase: "connected",
      sessionInitialized: true,
      sessionReady: true,
      providers: [provider],
      updateState: { status: "idle" },
      serverConfig: {
        environment: {
          environmentId: EnvironmentId.make("remote"),
          label: "remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: APP_VERSION,
          capabilities: { repositoryIdentity: true },
        },
        settings: { continueThreadsAfterServerUpdate: false },
      },
    };
    Object.assign(snapshot, { primaryEnvironmentId: null, machines: [machine] });
    let capture!: (ports: UpdatePlanPorts) => void;
    const ready = new Promise<UpdatePlanPorts>((resolve) => {
      capture = resolve;
    });
    vi.mocked(runUpdatePlan)
      .mockReset()
      .mockImplementation(async (_store, ports) => {
        capture(ports);
      });
    vi.mocked(runAtomCommand)
      .mockReset()
      .mockResolvedValue(
        AsyncResult.success({
          providers: [{ ...provider, version: "1.1.0", updateState: { status: "succeeded" } }],
        }),
      );
    try {
      expect(
        await startUpdatePlan(
          new Set([
            updateItemKey("provider", machine.environmentId, provider.driver, provider.instanceId),
          ]),
          null,
          false,
        ),
      ).toEqual({ status: "started" });
      const ports = await ready;
      if (mode === "legacy-plan")
        await store.change(
          (plan) =>
            plan && {
              ...plan,
              items: plan.items.map((item) => ({ ...item, targetVersion: "1.1.0" })),
            },
        );
      const item = (await store.read())!.items[0]!;
      const pinned = mode === "legacy-plan";
      expect(item.targetVersion).toBe(pinned ? "1.1.0" : "latest");
      expect(await ports.execute(item)).toEqual({ status: "done" });
      expect(runAtomCommand).toHaveBeenCalledWith(
        appAtomRegistry,
        expect.anything(),
        {
          environmentId: machine.environmentId,
          input: {
            provider: provider.driver,
            instanceId: provider.instanceId,
            ...(pinned ? { targetVersion: "1.1.0" } : {}),
          },
        },
        { reportFailure: false },
      );
      vi.mocked(runAtomCommand).mockClear();
      Object.assign(provider.versionAdvisory!, { latestVersion: "1.2.0" });
      expect((await ports.execute(item)).status).toBe(pinned ? "skipped" : "done");
      expect(runAtomCommand).toHaveBeenCalledTimes(pinned ? 0 : 1);
    } finally {
      Object.assign(snapshot, original);
      await store.discard();
    }
  },
);

it("persists the fourth OFF argument and sends it to native and server updates", async () => {
  const store = await updatePlanStore();
  await store.discard();
  const snapshot = appAtomRegistry.get(updateOptionsSnapshotAtom);
  const original = { ...snapshot };
  const bridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  const installUpdate = vi.fn(async () => ({ accepted: true, state: { status: "downloaded" } }));
  const machine = (id: string, hostedByThisApp: boolean): UpdateOptionMachine => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    hostedByThisApp,
    connected: true,
    enabled: true,
    canMaintain: true,
    canManageProviders: true,
    connectionPhase: "connected",
    sessionInitialized: true,
    sessionReady: true,
    providers: [],
    updateState: { status: "idle" },
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.1",
        capabilities: {
          repositoryIdentity: true,
          serverSelfUpdate: "boot-service",
          threadRestartContinuation: true,
          threadRestartContinuationControl: true,
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
  });
  const local = machine("local", true);
  const remote = machine("remote", false);
  Object.assign(snapshot, {
    primaryEnvironmentId: local.environmentId,
    canDisableLocalAutoResume: true,
    machines: [local, remote],
  });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { supportsUpdateThreadContinuationControl: true, installUpdate },
  });
  let capture!: (ports: UpdatePlanPorts) => void;
  const ready = new Promise<UpdatePlanPorts>((resolve) => {
    capture = resolve;
  });
  vi.mocked(runUpdatePlan)
    .mockReset()
    .mockImplementation(async (_store, ports) => {
      capture(ports);
    });
  vi.mocked(runAtomCommand).mockReset().mockResolvedValue(AsyncResult.success(undefined));
  try {
    expect(
      await startUpdatePlan(
        new Set([
          updateItemKey("app", local.environmentId),
          updateItemKey("server", remote.environmentId),
        ]),
        "9.9.9",
        true,
        false,
      ),
    ).toEqual({ status: "started" });
    const ports = await ready;
    const saved = (await store.read())!;
    expect(saved.items.map((item) => item.autoResume)).toEqual([false, false]);
    expect(await ports.install(saved.items.find((item) => item.kind === "app")!)).toBe(true);
    expect(installUpdate).toHaveBeenCalledWith("9.9.9", false);
    expect(await ports.execute(saved.items.find((item) => item.kind === "server")!)).toEqual({
      status: "done",
    });
    expect(runAtomCommand).toHaveBeenCalledWith(
      appAtomRegistry,
      expect.anything(),
      {
        environmentId: remote.environmentId,
        input: { targetVersion: "9.9.9", continueRunningThreads: false },
      },
      { reportFailure: false },
    );
  } finally {
    Object.assign(snapshot, original);
    Object.defineProperty(
      window,
      "desktopBridge",
      bridge ?? { configurable: true, value: undefined },
    );
    await store.discard();
  }
});

it.each([6_000, 6_001])(
  "clears the expired countdown at %s when readiness loss releases the local claim",
  async (expiredAt) => {
    const store = await updatePlanStore();
    await store.discard();
    const snapshot = appAtomRegistry.get(updateOptionsSnapshotAtom);
    const actual =
      await vi.importActual<typeof import("./updateEverythingPlan")>("./updateEverythingPlan");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (restart: boolean) => void;
    const finished = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const install = vi.fn(async () => true);
    vi.mocked(runUpdatePlan)
      .mockReset()
      .mockImplementation((store, ports) =>
        actual.runUpdatePlan(store, {
          ...ports,
          now: () => 1_000,
          download: async () => true,
          waitForMaintenance: async () => {},
          countdown: () => {
            void ports.countdown();
            entered();
            return finished;
          },
          install,
        }),
      );
    vi.mocked(useDesktopUpdateState).mockReset();
    using now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await using screen = await render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <UpdateEverythingCoordinator />
          <RestartProgress now={1_000} />
        </RegistryContext.Provider>,
      );
      await store.create({
        schemaVersion: 1,
        id: "countdown",
        primaryEnvironmentId: snapshot.primaryEnvironmentId,
        sourceVersion: APP_VERSION,
        createdAt: 1_000,
        phase: "local",
        pausedReason: null,
        items: [
          {
            key: "app:local",
            kind: "app",
            environmentId: EnvironmentId.make("local"),
            label: "local",
            fromVersion: APP_VERSION,
            targetVersion: "9.9.9",
            driver: null,
            instanceId: null,
            continueThreads: false,
            status: "pending",
            claimId: null,
            message: null,
          },
        ],
      });
      await started;
      await expect.element(screen.getByRole("status")).toHaveTextContent("Restart in 5s: 6000");
      await act(async () => {
        await store.change((plan) => plan && { ...plan });
        await store.read();
      });
      await expect.element(screen.getByRole("status")).toHaveTextContent("Restart in 5s: 6000");
      await act(() => {
        now.mockReturnValue(expiredAt);
        appAtomRegistry.update(optionsSnapshotAtom, (current) => ({ ...current, ready: false }));
        finish(true);
      });
      await screen.rerender(
        <RegistryContext.Provider value={appAtomRegistry}>
          <UpdateEverythingCoordinator />
          <RestartProgress now={expiredAt} />
        </RegistryContext.Provider>,
      );
      await vi.waitFor(async () => {
        const plan = await store.read();
        expect(plan?.phase).toBe("local");
        expect(plan?.items[0]).toMatchObject({ status: "pending", claimId: null });
      });
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent("Preparing this device: null");
      expect(install).not.toHaveBeenCalled();
      await store.change((plan) => plan && { ...plan, phase: "awaiting-local" });
      await expect.element(screen.getByRole("status")).toHaveTextContent("Restarting…: null");
    } finally {
      finish(true);
      postponeUpdateRestart();
      appAtomRegistry.update(optionsSnapshotAtom, () => snapshot);
      await store.discard();
    }
  },
);
