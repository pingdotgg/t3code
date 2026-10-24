import { Atom, AtomRegistry } from "effect/reactivity";
import {
  isHostedMaintenanceReady,
  waitForHostedMaintenance,
  type HostedMaintenanceSnapshot,
} from "./updateEverythingMaintenance";
import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import { downloadUpdateForPlan, observeDesktopInstallFailure } from "./updateEverythingDesktop";
import { expect, it } from "vite-plus/test";
import { retryExecutionPlan } from "./updateEverythingExecution";
import {
  runUpdatePlan,
  type UpdateExecutionPlan,
  type UpdatePlanItem,
  type UpdatePlanPorts,
  type UpdatePlanStore,
  type ItemResolution,
} from "./updateEverythingPlan";

function deferred<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const item = (key: string, kind: UpdatePlanItem["kind"]): UpdatePlanItem => ({
  key,
  kind,
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
});
function setup(items = [item("app", "app"), item("remote", "server"), item("tool", "provider")]) {
  let plan: UpdateExecutionPlan | null = {
    schemaVersion: 1,
    id: "plan",
    primaryEnvironmentId: EnvironmentId.make("primary"),
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: items.some((i) => i.kind === "app") ? "local" : "servers",
    pausedReason: null,
    items,
  };
  const store: UpdatePlanStore = {
    read: async () => plan,
    change: async (update) => (plan = update(plan)),
  };
  const calls: string[] = [];
  const ports: UpdatePlanPorts = {
    claimId: "old-renderer",
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: () => ({ status: "ready" }),
    download: async () => {
      calls.push("download");
      return true;
    },
    maintenanceReady: () => true,
    waitForMaintenance: async () => {
      calls.push("maintenance");
    },
    countdown: async () => true,
    install: async () => {
      calls.push("install");
      return true;
    },
    execute: async (i) => {
      calls.push(i.key);
      return { status: "done" };
    },
  };
  return { store, ports, calls };
}

it.each(["app", "awaiting-local", "server", "provider"] as const)(
  "does not pause a healthy foreign %s claim during recovery",
  async (kind) => {
    const { store, ports, calls } = setup([item("work", kind === "awaiting-local" ? "app" : kind)]);
    await store.change(
      (plan) =>
        plan && {
          ...plan,
          phase:
            kind === "awaiting-local"
              ? "awaiting-local"
              : kind === "app"
                ? "local"
                : kind === "server"
                  ? "servers"
                  : "providers",
          items: plan.items.map((item) => ({ ...item, status: "claimed", claimId: "live-owner" })),
        },
    );
    const initial = await store.read();
    await runUpdatePlan(store, {
      ...ports,
      recoveringClaims: true,
      isClaimOwnerAlive: async () => true,
      resolve: () => ({ status: "unknown" }),
    });
    expect(await store.read()).toEqual(initial);
    expect(calls).toEqual([]);
  },
);

it.each(["app", "awaiting-local", "server", "provider"] as const)(
  "only pauses the exact abandoned %s claim observed before checking its owner",
  async (kind) => {
    for (const change of ["none", "claim", "settled", "phase", "replaced"] as const) {
      const { store, ports, calls } = setup([
        item("work", kind === "awaiting-local" ? "app" : kind),
      ]);
      await store.change(
        (plan) =>
          plan && {
            ...plan,
            phase:
              kind === "awaiting-local"
                ? "awaiting-local"
                : kind === "app"
                  ? "local"
                  : kind === "server"
                    ? "servers"
                    : "providers",
            items: plan.items.map((item) => ({
              ...item,
              status: "claimed",
              claimId: "dead-owner",
            })),
          },
      );
      let afterQuery: UpdateExecutionPlan | null = null;
      await runUpdatePlan(store, {
        ...ports,
        recoveringClaims: true,
        resolve: () => ({ status: "unknown" }),
        isClaimOwnerAlive: async () => {
          afterQuery = await store.change(
            (plan) =>
              plan && {
                ...plan,
                id: change === "replaced" ? "replacement" : plan.id,
                phase: change === "phase" ? "complete" : plan.phase,
                items: plan.items.map((item) => ({
                  ...item,
                  claimId: change === "claim" ? "new-owner" : item.claimId,
                  status: change === "settled" ? "done" : item.status,
                })),
              },
          );
          return false;
        },
      });
      if (change === "none") expect((await store.read())?.phase).toBe("paused");
      else if (change === "settled") {
        expect((await store.read())?.phase).not.toBe("paused");
        expect((await store.read())?.items[0]?.status).toBe("done");
      } else expect(await store.read()).toEqual(afterQuery);
      expect(calls).toEqual([]);
    }
  },
);

it.each(["claimed", "unknown"] as const)(
  "retry checks %s work without blocking settled, idle own, or app retries",
  async (status) => {
    for (const kind of ["app", "server", "provider"] as const) {
      for (const owner of ["live", "dead", "own"] as const) {
        const { store, ports } = setup([item("work", kind)]);
        const initial = (await store.change(
          (plan) =>
            plan && {
              ...plan,
              phase: "paused",
              pausedReason: kind === "app" ? "download-failed" : "unknown",
              items: plan.items.map((item) => ({
                ...item,
                status,
                claimId: owner === "own" ? ports.claimId : "foreign-renderer",
              })),
            },
        ))!;
        const retried = retryExecutionPlan(
          initial,
          ports.appVersion,
          () => ({ status: "unknown" }),
          {
            plan: initial,
            rendererClaimId: ports.claimId,
            deadClaims: owner === "dead" ? initial.items : [],
          },
        );
        if (kind !== "app" && status === "claimed" && owner === "live")
          expect(retried).toBe(initial);
        else {
          expect(retried.phase).toBe(kind === "app" ? "local" : "servers");
          expect(retried.items[0]?.status).toBe("pending");
          expect(retried.items[0]?.claimId).toBeNull();
        }
      }
    }
  },
);

it.each(["plan", "phase", "claim", "own-claim", "status", "key", "new-claim"] as const)(
  "retry preserves changed %s state after querying a dead foreign owner",
  async (change) => {
    const { store, ports } = setup([item("work", "server"), item("tool", "provider")]);
    const initial = (await store.change(
      (plan) =>
        plan && {
          ...plan,
          phase: "paused",
          pausedReason: "unknown",
          items: plan.items.map((item) =>
            item.key === "work"
              ? {
                  ...item,
                  status: change === "status" ? "unknown" : "claimed",
                  claimId: "dead-owner",
                }
              : item,
          ),
        },
    ))!;
    const current = (await store.change(
      (plan) =>
        plan && {
          ...plan,
          id: change === "plan" ? "replacement" : plan.id,
          phase: change === "phase" ? "complete" : plan.phase,
          items: plan.items.map((item) =>
            item.key === "work"
              ? {
                  ...item,
                  key: change === "key" ? "replacement" : item.key,
                  claimId:
                    change === "claim"
                      ? "new-owner"
                      : change === "own-claim"
                        ? ports.claimId
                        : item.claimId,
                  status: change === "status" ? "claimed" : item.status,
                }
              : change === "new-claim"
                ? { ...item, status: "claimed", claimId: "dead-owner" }
                : item,
          ),
        },
    ))!;
    expect(
      retryExecutionPlan(current, ports.appVersion, () => ({ status: "unknown" }), {
        plan: initial,
        rendererClaimId: ports.claimId,
        deadClaims: change === "status" ? [] : [initial.items[0]!],
      }),
    ).toBe(current);
  },
);

it("does not dispatch an own claim reset by Retry before its admission read returns", async () => {
  const { store, ports, calls } = setup([item("work", "server")]);
  await runUpdatePlan(
    {
      ...store,
      read: async () => {
        const plan = await store.read();
        if (plan?.items[0]?.status !== "claimed") return plan;
        return store.change(
          (current) =>
            current && {
              ...current,
              items: current.items.map((item) => ({ ...item, status: "pending", claimId: null })),
            },
        );
      },
    },
    ports,
  );
  expect(calls).toEqual([]);
  expect((await store.read())?.items[0]?.status).toBe("pending");
});

it("installs only the current app before restart, then releases the frozen remaining items once", async () => {
  const { store, ports, calls } = setup();
  await runUpdatePlan(store, ports);
  expect(calls).toEqual(["download", "maintenance", "maintenance", "maintenance", "install"]);
  expect((await store.read())?.phase).toBe("awaiting-local");
  await runUpdatePlan(store, { ...ports, isClaimOwnerAlive: async () => false });
  expect(calls).toHaveLength(5);
  await runUpdatePlan(store, { ...ports, claimId: "new-renderer", appVersion: "1.0.1" });
  expect(calls).toEqual([
    "download",
    "maintenance",
    "maintenance",
    "maintenance",
    "install",
    "remote",
    "tool",
  ]);
  await runUpdatePlan(store, { ...ports, claimId: "another-renderer", appVersion: "1.0.1" });
  expect(calls).toHaveLength(7);
});

it("waits for the exact downloaded event after an early completed RPC and installs once", async () => {
  const { store, ports, calls } = setup();
  const state: DesktopUpdateState = {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: "1.0.0",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: "1.0.1",
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  const rpc = deferred<void>();
  let listener: (state: DesktopUpdateState) => void = () => {};
  let unsubscribed = false;
  const running = runUpdatePlan(store, {
    ...ports,
    download: (item) =>
      downloadUpdateForPlan(
        {
          getUpdateState: async () => state,
          downloadUpdate: async () => {
            rpc.resolve(undefined);
            return { accepted: true, completed: true, state };
          },
          onUpdateState: (update) => {
            listener = update;
            return () => {
              unsubscribed = true;
            };
          },
        },
        item.targetVersion,
      ),
  });
  await rpc.promise;
  expect(calls).not.toContain("install");
  listener({ ...state, status: "downloaded", downloadedVersion: "1.0.1" });
  await running;
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
  expect((await store.read())?.phase).toBe("awaiting-local");
  expect(unsubscribed).toBe(true);
});

it("pauses an accepted install after a later native failure and never releases remote work", async () => {
  const { store, ports, calls } = setup();
  await runUpdatePlan(store, ports);
  const state: DesktopUpdateState = {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "1.0.0",
    hostArch: "x64",
    appArch: "x64",
    runningUnderArm64Translation: false,
    availableVersion: "1.0.1",
    downloadedVersion: "1.0.1",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: "Installer failed. Backends recovered.",
    errorContext: "install",
    canRetry: true,
  };
  await store.change((plan) => observeDesktopInstallFailure(plan, state));
  await runUpdatePlan(store, ports);
  expect((await store.read())?.phase).toBe("paused");
  expect((await store.read())?.pausedReason).toBe("install-refused");
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
  expect(calls).not.toContain("remote");
});

it("offers manual review for an expired awaiting-local record even on its source version", async () => {
  const { store, ports, calls } = setup();
  await runUpdatePlan(store, ports);
  await runUpdatePlan(store, { ...ports, now: () => 60 * 60 * 1000 });
  expect((await store.read())?.pausedReason).toBe("expired");
  expect(calls).not.toContain("remote");
});

it("does not install when saving the restart record fails", async () => {
  const { store, ports, calls } = setup();
  await expect(
    runUpdatePlan(
      {
        ...store,
        change: async (update) =>
          store.change((plan) => {
            const changed = update(plan);
            if (changed?.phase === "awaiting-local") throw new Error("Storage full");
            return changed;
          }),
      },
      ports,
    ),
  ).rejects.toThrow("Storage full");
  expect(calls).not.toContain("install");
  expect(calls).not.toContain("remote");
});

it.each(["download", "later", "install"])(
  "pauses the whole plan when local %s stops",
  async (stopped) => {
    const { store, ports, calls } = setup();
    await runUpdatePlan(store, {
      ...ports,
      download: async () => stopped !== "download",
      countdown: async () => stopped !== "later",
      install: async () => stopped !== "install",
    });
    expect((await store.read())?.phase).toBe("paused");
    expect((await store.read())?.pausedReason).toBe(
      stopped === "download"
        ? "download-failed"
        : stopped === "later"
          ? "later"
          : "install-refused",
    );
    expect(calls).not.toContain("remote");
  },
);

it("does not release remote work on the wrong version or reinstall from a new mount", async () => {
  const { store, ports, calls } = setup();
  await runUpdatePlan(store, ports);
  await runUpdatePlan(store, { ...ports, claimId: "new", appVersion: "1.0.2" });
  expect((await store.read())?.pausedReason).toBe("wrong-version");
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
  expect(calls).not.toContain("remote");
});

it("waits for catalog and session readiness before recovery", async () => {
  const { store, ports, calls } = setup();
  await runUpdatePlan(store, { ...ports, ready: () => false });
  expect(calls).toEqual([]);
  expect((await store.read())?.phase).toBe("local");
});

it("the old app renderer cannot run the remaining phases after another renderer unlocks them", async () => {
  const { store, ports, calls } = setup();
  await store.change(
    (plan) =>
      plan && {
        ...plan,
        phase: "servers",
        items: plan.items.map((item) => (item.kind === "app" ? { ...item, status: "done" } : item)),
      },
  );
  await runUpdatePlan(store, ports);
  expect(calls).toEqual([]);
  expect((await store.read())?.phase).toBe("servers");
});

it("pauses an unrelated browser client version instead of running a stale plan", async () => {
  const { store, ports, calls } = setup([item("remote", "server")]);
  await runUpdatePlan(store, { ...ports, appVersion: "9.0.0" });
  expect(calls).toEqual([]);
  expect((await store.read())?.pausedReason).toBe("wrong-version");
});

it("runs remote servers concurrently and waits for full readiness before tools", async () => {
  const { store, ports, calls } = setup([
    item("a", "server"),
    item("b", "server"),
    item("tools", "provider"),
  ]);
  const a = deferred<ItemResolution>();
  const b = deferred<ItemResolution>();
  const started = deferred<void>();
  const running = runUpdatePlan(store, {
    ...ports,
    execute: async (i) => {
      calls.push(i.key);
      if (calls.length === 2) started.resolve(undefined);
      return i.key === "a" ? a.promise : i.key === "b" ? b.promise : { status: "done" };
    },
  });
  await started.promise;
  expect(calls).toEqual(["a", "b"]);
  a.resolve({ status: "done" });
  b.resolve({ status: "done" });
  await running;
  expect(calls).toEqual(["a", "b", "tools"]);
});

it("skips tools of a failed selected server and still updates other tools", async () => {
  const failedTool = { ...item("a-tool", "provider"), environmentId: EnvironmentId.make("a") };
  const { store, ports, calls } = setup([
    item("a", "server"),
    failedTool,
    item("other-tool", "provider"),
  ]);
  await runUpdatePlan(store, {
    ...ports,
    execute: async (i) => {
      calls.push(i.key);
      return { status: i.key === "a" ? "failed" : "done" };
    },
  });
  expect(calls).toEqual(["a", "other-tool"]);
  expect((await store.read())?.items.find((i) => i.key === "a-tool")?.status).toBe("skipped");
});

it("does not replay a claimed operation after loss of its renderer", async () => {
  const { store, ports, calls } = setup([
    { ...item("a", "server"), status: "claimed", claimId: "lost" },
  ]);
  await runUpdatePlan(store, {
    ...ports,
    recoveringClaims: true,
    resolve: () => ({ status: "unknown", message: "Review before retry" }),
  });
  expect(calls).toEqual([]);
  expect((await store.read())?.items[0]?.status).toBe("claimed");
  expect((await store.read())?.pausedReason).toBe("unknown");
});

it("an already open source-version window cannot pause another window's app install", async () => {
  const { store, ports, calls } = setup();
  const installing = deferred<void>();
  const accepted = deferred<boolean>();
  const first = runUpdatePlan(store, {
    ...ports,
    install: async () => {
      installing.resolve(undefined);
      return accepted.promise;
    },
  });
  await installing.promise;
  await runUpdatePlan(store, { ...ports, claimId: "other-window" });
  expect((await store.read())?.phase).toBe("awaiting-local");
  expect(calls).not.toContain("remote");
  accepted.resolve(true);
  await first;
});

it("a foreign recovery pause cannot release tools and the undispatched owner can safely restore pending", async () => {
  const { store, ports, calls } = setup([item("remote", "server"), item("tool", "provider")]);
  const claimed = deferred<void>();
  const dispatch = deferred<void>();
  let pauseAtClaim = true;
  const first = runUpdatePlan(
    {
      ...store,
      change: async (update) => {
        const changed = await store.change(update);
        if (pauseAtClaim && changed?.items[0]?.status === "claimed") {
          pauseAtClaim = false;
          claimed.resolve(undefined);
          await dispatch.promise;
        }
        return changed;
      },
    },
    ports,
  );
  await claimed.promise;
  await runUpdatePlan(store, {
    ...ports,
    claimId: "other",
    recoveringClaims: true,
    resolve: () => ({ status: "unknown" }),
  });
  expect((await store.read())?.phase).toBe("paused");
  expect(calls).toEqual([]);
  dispatch.resolve(undefined);
  await first;
  expect(calls).toEqual([]);
  expect((await store.read())?.items[0]?.status).toBe("pending");
  await store.change((plan) => plan && { ...plan, phase: "servers", pausedReason: null });
  await runUpdatePlan(store, {
    ...ports,
    claimId: "recovery",
    resolve: (i, recovering) => ({ status: recovering ? "done" : "ready" }),
  });
  expect(calls).toEqual(["remote", "tool"]);
});

it("reconciles a confirmed terminal foreign result without sending its server command again", async () => {
  const { store, ports, calls } = setup([
    { ...item("remote", "server"), status: "claimed", claimId: "lost-renderer" },
    item("tool", "provider"),
  ]);
  await runUpdatePlan(store, {
    ...ports,
    recoveringClaims: true,
    resolve: (_selected, recovering) => ({ status: recovering ? "done" : "ready" }),
  });
  expect(calls).toEqual(["tool"]);
  expect((await store.read())?.items[0]?.status).toBe("done");
});

it("stops before dispatch when persistence fails", async () => {
  const { store, ports, calls } = setup();
  await expect(
    runUpdatePlan(
      {
        ...store,
        change: async () => {
          throw new Error("disk");
        },
      },
      ports,
    ),
  ).rejects.toThrow("disk");
  expect(calls).toEqual([]);
});

it("rechecks execution permission after the atomic claim", async () => {
  const { store, ports, calls } = setup([item("remote", "server")]);
  let checks = 0;
  await runUpdatePlan(store, {
    ...ports,
    resolve: () =>
      ++checks === 1 ? { status: "ready" } : { status: "skipped", message: "Permission revoked" },
  });
  expect(calls).toEqual([]);
  expect((await store.read())?.items[0]?.message).toBe("Permission revoked");
});

it("keeps the global T3 barrier when readiness changes to wait after claim and resumes once", async () => {
  const { store, ports, calls } = setup([
    item("remote", "server"),
    item("other-tools", "provider"),
  ]);
  let checks = 0;
  await runUpdatePlan(store, {
    ...ports,
    resolve: (selected) =>
      selected.kind === "server" && ++checks === 2 ? { status: "wait" } : { status: "ready" },
  });
  expect(calls).toEqual([]);
  expect((await store.read())?.phase).toBe("servers");
  expect((await store.read())?.items[0]?.status).toBe("pending");
  await runUpdatePlan(store, ports);
  await runUpdatePlan(store, ports);
  expect(calls).toEqual(["remote", "other-tools"]);
});

it.each(["countdown", "install"] as const)(
  "the same renderer recovers local readiness lost before %s",
  async (barrier) => {
    const { store, ports, calls } = setup();
    let ready = true;
    let maintenance = 0;
    const controlled = {
      ...ports,
      ready: () => ready,
      maintenanceReady: () => true,
      waitForMaintenance: async () => {
        maintenance += 1;
        if (
          (barrier === "countdown" && maintenance === 1) ||
          (barrier === "install" && maintenance === 2)
        )
          ready = false;
      },
    };
    await runUpdatePlan(store, controlled);
    expect(calls).not.toContain("install");
    expect((await store.read())?.items[0]?.status).toBe("pending");
    ready = true;
    await runUpdatePlan(store, controlled);
    await runUpdatePlan(store, controlled);
    expect(calls.filter((call) => call === "install")).toHaveLength(1);
    expect((await store.read())?.phase).toBe("awaiting-local");
  },
);

it.each(["server", "provider"] as const)(
  "the same renderer recovers readiness lost before %s execution",
  async (kind) => {
    const { store, ports, calls } = setup([item("selected", kind)]);
    let ready = true;
    let changedAfterClaim = false;
    const controlledStore = {
      ...store,
      change: async (update: Parameters<UpdatePlanStore["change"]>[0]) => {
        const saved = await store.change(update);
        if (!changedAfterClaim && saved?.items[0]?.status === "claimed") {
          changedAfterClaim = true;
          ready = false;
        }
        return saved;
      },
    };
    const controlled = { ...ports, ready: () => ready };
    await runUpdatePlan(controlledStore, controlled);
    expect(calls).toEqual([]);
    expect((await store.read())?.items[0]?.status).toBe("pending");
    ready = true;
    await runUpdatePlan(controlledStore, controlled);
    await runUpdatePlan(controlledStore, controlled);
    expect(calls).toEqual(["selected"]);
  },
);

it("restores local pending if readiness is lost while saving the restart record", async () => {
  const { store, ports, calls } = setup();
  let ready = true;
  let interrupted = false;
  const controlledStore = {
    ...store,
    change: async (update: Parameters<UpdatePlanStore["change"]>[0]) => {
      const saved = await store.change(update);
      if (!interrupted && saved?.phase === "awaiting-local") {
        interrupted = true;
        ready = false;
      }
      return saved;
    },
  };
  const controlled = { ...ports, ready: () => ready };
  await runUpdatePlan(controlledStore, controlled);
  expect(calls).not.toContain("install");
  expect((await store.read())?.phase).toBe("local");
  expect((await store.read())?.items[0]?.status).toBe("pending");
  ready = true;
  await runUpdatePlan(controlledStore, controlled);
  expect(calls.filter((call) => call === "install")).toHaveLength(1);
});

it("never releases or repeats an already dispatched claim when owner readiness is lost", async () => {
  const { store, ports, calls } = setup([item("remote", "server")]);
  const started = deferred<void>();
  const finished = deferred<ItemResolution>();
  const running = runUpdatePlan(store, {
    ...ports,
    execute: async (selected) => {
      calls.push(selected.key);
      started.resolve(undefined);
      return finished.promise;
    },
  });
  await started.promise;
  await runUpdatePlan(store, { ...ports, ready: () => false });
  await runUpdatePlan(store, ports);
  expect((await store.read())?.items[0]?.status).toBe("claimed");
  expect((await store.read())?.items[0]?.claimId).toBe(ports.claimId);
  expect(calls).toEqual(["remote"]);
  finished.resolve({ status: "done" });
  await running;
  expect(calls).toEqual(["remote"]);
  expect((await store.read())?.phase).toBe("complete");
});

it.each(["servers", "providers"] as const)(
  "never passes an unknown T3 item from the %s phase",
  async (phase) => {
    const { store, ports, calls } = setup([
      { ...item("remote", "server"), status: "unknown" },
      item("tools", "provider"),
    ]);
    await store.change((plan) => plan && { ...plan, phase });
    await runUpdatePlan(store, ports);
    expect(calls).toEqual([]);
    expect((await store.read())?.phase).toBe("paused");
    expect((await store.read())?.pausedReason).toBe("unknown");
  },
);

it("pauses unknown T3 from the initial preclaim resolution", async () => {
  const { store, ports, calls } = setup([item("remote", "server"), item("tools", "provider")]);
  await runUpdatePlan(store, {
    ...ports,
    resolve: (selected) => ({ status: selected.kind === "server" ? "unknown" : "ready" }),
  });
  expect(calls).toEqual([]);
  expect((await store.read())?.phase).toBe("paused");
});

it("pauses unknown T3 results before the global tools phase", async () => {
  const { store, ports, calls } = setup([
    item("remote", "server"),
    item("other-tools", "provider"),
  ]);
  await runUpdatePlan(store, {
    ...ports,
    execute: async (i) => {
      calls.push(i.key);
      return { status: "unknown" };
    },
  });
  expect(calls).toEqual(["remote"]);
  expect((await store.read())?.pausedReason).toBe("unknown");
});

it("does not repeat a live foreign claim or pass it at the global barrier", async () => {
  const { store, ports, calls } = setup([item("remote", "server"), item("tools", "provider")]);
  const started = deferred<void>();
  const finish = deferred<ItemResolution>();
  const running = runUpdatePlan(store, {
    ...ports,
    execute: async (i) => {
      calls.push(i.key);
      if (i.kind === "server") {
        started.resolve(undefined);
        return finish.promise;
      }
      return { status: "done" };
    },
  });
  await started.promise;
  await runUpdatePlan(store, {
    ...ports,
    claimId: "observer",
    resolve: () => ({ status: "unknown" }),
  });
  expect(calls).toEqual(["remote"]);
  expect((await store.read())?.phase).toBe("servers");
  finish.resolve({ status: "done" });
  await running;
  expect(calls).toEqual(["remote", "tools"]);
});

it.each(["finish", "pause", "readiness", "claim"] as const)(
  "waits for hosted work started by the restart-record transaction and rechecks %s",
  async (changeDuringWait) => {
    const { store, ports, calls } = setup();
    const registry = AtomRegistry.make();
    const state = (status: "queued" | "running" | "succeeded"): HostedMaintenanceSnapshot => ({
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [false, true].map((wsl) => ({
        hostedByThisApp: true,
        connected: true,
        sessionReady: true,
        providers: [
          {
            updateState: {
              status: !wsl && status === "queued" ? "running" : status,
              startedAt: null,
              finishedAt: null,
              message: null,
              output: null,
            },
          },
        ],
      })),
    });
    const source = Atom.make(state("succeeded"));
    const waiting = deferred<"waiting">();
    const installing = deferred<"installing">();
    let ready = true;
    let checks = 0;
    const controlledStore = {
      ...store,
      change: async (update: Parameters<UpdatePlanStore["change"]>[0]) => {
        const saved = await store.change(update);
        if (saved?.phase === "awaiting-local") registry.set(source, state("queued"));
        return saved;
      },
    };
    const controlled = {
      ...ports,
      ready: () => ready,
      maintenanceReady: () => isHostedMaintenanceReady(registry.get(source)),
      waitForMaintenance: () => {
        if (++checks === 3) waiting.resolve("waiting");
        return waitForHostedMaintenance(registry, source);
      },
      install: async () => {
        installing.resolve("installing");
        return ports.install(item("app", "app"));
      },
    };
    try {
      const running = runUpdatePlan(controlledStore, controlled);
      expect(await Promise.race([waiting.promise, installing.promise])).toBe("waiting");
      expect(calls).not.toContain("install");
      registry.set(source, state("running"));
      if (changeDuringWait === "pause")
        await store.change((plan) => plan && { ...plan, phase: "paused", pausedReason: "later" });
      if (changeDuringWait === "readiness") ready = false;
      if (changeDuringWait === "claim")
        await store.change(
          (plan) =>
            plan && {
              ...plan,
              items: plan.items.map((item) =>
                item.kind === "app" ? { ...item, claimId: "other" } : item,
              ),
            },
        );
      expect(calls).not.toContain("install");
      registry.set(source, state("succeeded"));
      await running;
      expect(calls.filter((call) => call === "install")).toHaveLength(
        changeDuringWait === "finish" ? 1 : 0,
      );
      if (changeDuringWait === "claim")
        expect((await store.read())?.items[0]?.claimId).toBe("other");
    } finally {
      registry.dispose();
    }
  },
);

it.each(["queued", "running"] as const)(
  "returns its undispatched app claim to pending when hosted work becomes %s during the final read",
  async (status) => {
    const { store, ports, calls } = setup();
    const registry = AtomRegistry.make();
    const state = (status: "queued" | "running" | "succeeded"): HostedMaintenanceSnapshot => ({
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [
        {
          hostedByThisApp: true,
          connected: true,
          sessionReady: true,
          providers: [
            {
              updateState: {
                status,
                startedAt: null,
                finishedAt: null,
                message: null,
                output: null,
              },
            },
          ],
        },
      ],
    });
    const source = Atom.make(state("succeeded"));
    let interrupted = false;
    const controlledStore = {
      ...store,
      read: async () => {
        const saved = await store.read();
        if (!interrupted && saved?.phase === "awaiting-local") {
          interrupted = true;
          registry.set(source, state(status));
        }
        return saved;
      },
    };
    const controlled = {
      ...ports,
      waitForMaintenance: () => waitForHostedMaintenance(registry, source),
      maintenanceReady: () => isHostedMaintenanceReady(registry.get(source)),
    };
    try {
      await runUpdatePlan(controlledStore, controlled);
      expect(calls).not.toContain("install");
      expect((await store.read())?.phase).toBe("local");
      expect((await store.read())?.items[0]?.status).toBe("pending");
      registry.set(source, state("succeeded"));
      await runUpdatePlan(controlledStore, controlled);
      await runUpdatePlan(controlledStore, controlled);
      expect(calls.filter((call) => call === "install")).toHaveLength(1);
      expect((await store.read())?.phase).toBe("awaiting-local");
    } finally {
      registry.dispose();
    }
  },
);
