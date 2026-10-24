import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { randomUUID } from "~/lib/utils";
import { openUpdatePlanStore } from "./updateEverythingPlanStore";
import type { UpdateExecutionPlan } from "./updateEverythingPlan";
import { runUpdatePlan, type UpdatePlanPorts } from "./updateEverythingPlan";
import { createUpdatePlanClaimOwner, retryExecutionPlan } from "./updateEverythingExecution";

function deferred<A = void>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function plan(): UpdateExecutionPlan {
  return {
    schemaVersion: 1,
    id: "first",
    primaryEnvironmentId: EnvironmentId.make("primary"),
    sourceVersion: "1.0.0",
    createdAt: 0,
    phase: "servers",
    pausedReason: null,
    items: [
      {
        key: "server",
        kind: "server",
        environmentId: EnvironmentId.make("remote"),
        label: "remote",
        fromVersion: "1.0.0",
        targetVersion: "1.0.1",
        driver: null,
        instanceId: null,
        continueThreads: false,
        status: "pending",
        claimId: null,
        message: null,
      },
    ],
  };
}

it("two IndexedDB connections cannot replace the single active plan", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using first = await openUpdatePlanStore(name);
  await using second = await openUpdatePlanStore(name);
  const saves = await Promise.all([
    first.create(plan()),
    second.create({ ...plan(), id: "second" }),
  ]);
  expect(saves.filter(Boolean)).toHaveLength(1);
  expect((await second.read())?.id).toBe(saves[0] ? "first" : "second");
});

it("rejects malformed data and future schemas before any change", async () => {
  await using store = await openUpdatePlanStore(`update-plan-test-${randomUUID()}`);
  await expect(
    store.change(() => ({ ...plan(), schemaVersion: 2 }) as unknown as UpdateExecutionPlan),
  ).rejects.toThrow();
  expect(await store.read()).toBeNull();
});

it("aborts a failed write without publishing an active plan", async () => {
  await using store = await openUpdatePlanStore(`update-plan-test-${randomUUID()}`);
  using _put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  await expect(store.create(plan())).rejects.toThrow("Storage full");
  expect(await store.read()).toBeNull();
});

it("can explicitly discard an unreadable future plan so selection can be reviewed again", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using store = await openUpdatePlanStore(name);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("plan", "readwrite");
      transaction.objectStore("plan").put({ ...plan(), schemaVersion: 2 }, "active");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
    await expect(store.read()).rejects.toThrow();
    await store.discard();
    expect(await store.read()).toBeNull();
  } finally {
    database.close();
  }
});

it("two real database runners send one server command and keep tools behind its completion", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using first = await openUpdatePlanStore(name);
  await using second = await openUpdatePlanStore(name);
  const initial = plan();
  await first.create({
    ...initial,
    items: [...initial.items, { ...initial.items[0]!, key: "tool", kind: "provider" }],
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const calls: string[] = [];
  const ports: UpdatePlanPorts = {
    claimId: "a",
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: (_item, recovering) => ({ status: recovering ? "wait" : "ready" }),
    download: async () => true,
    maintenanceReady: () => true,
    waitForMaintenance: async () => {},
    countdown: async () => true,
    install: async () => true,
    execute: async (item) => {
      calls.push(item.kind);
      if (item.kind === "server") {
        entered();
        await finished;
      }
      return { status: "done" };
    },
  };
  const running = Promise.all([
    runUpdatePlan(first, ports),
    runUpdatePlan(second, { ...ports, claimId: "b" }),
  ]);
  await started;
  expect(calls).toEqual(["server"]);
  expect((await second.read())?.items[0]?.status).toBe("claimed");
  complete();
  await running;
  expect(calls).toEqual(["server", "provider"]);
  expect((await first.read())?.phase).toBe("complete");
});

it("keeps a live app owner's download and countdown intact across another window's recovery", async () => {
  const name = `update-plan-test-${randomUUID()}`;
  await using first = await openUpdatePlanStore(name);
  await using second = await openUpdatePlanStore(name);
  const observerId = randomUUID();
  await using observer = createUpdatePlanClaimOwner(observerId, () => {}, navigator.locks);
  await observer.ready;
  await first.create({ ...plan(), phase: "local", items: [{ ...plan().items[0]!, kind: "app" }] });
  const downloading = deferred();
  const downloaded = deferred<boolean>();
  const counting = deferred();
  const counted = deferred<boolean>();
  const install = vi.fn(async () => true);
  const ports: UpdatePlanPorts = {
    claimId: randomUUID(),
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: () => ({ status: "ready" }),
    download: () => {
      downloading.resolve();
      return downloaded.promise;
    },
    waitForMaintenance: async () => {},
    maintenanceReady: () => true,
    countdown: () => {
      counting.resolve();
      return counted.promise;
    },
    install,
    execute: async () => ({ status: "done" }),
  };
  const ownerId = randomUUID();
  await using liveOwner = createUpdatePlanClaimOwner(ownerId, () => {}, navigator.locks);
  await liveOwner.ready;
  const running = runUpdatePlan(first, { ...ports, claimId: ownerId });
  const recovery = {
    ...ports,
    claimId: observerId,
    recoveringClaims: true,
    isClaimOwnerAlive: observer.isAlive!,
  };
  try {
    await downloading.promise;
    await runUpdatePlan(second, recovery);
    expect((await second.read())?.phase).toBe("local");
    downloaded.resolve(true);
    await counting.promise;
    await runUpdatePlan(second, recovery);
    expect((await second.read())?.phase).toBe("local");
    counted.resolve(true);
    await running;
    await runUpdatePlan(second, recovery);
    expect((await second.read())?.phase).toBe("awaiting-local");
    expect(install).toHaveBeenCalledTimes(1);
  } finally {
    downloaded.resolve(false);
    counted.resolve(false);
    await running;
  }
});

it("wakes once after an owner exits and requires an explicit retry before another native dispatch", async () => {
  await using store = await openUpdatePlanStore(`update-plan-test-${randomUUID()}`);
  const ownerId = randomUUID();
  await using owner = createUpdatePlanClaimOwner(ownerId, () => {}, navigator.locks);
  const released = deferred();
  const wake = vi.fn(() => released.resolve());
  const observerId = randomUUID();
  await using observer = createUpdatePlanClaimOwner(observerId, wake, navigator.locks);
  await Promise.all([owner.ready, observer.ready]);
  await store.create({
    ...plan(),
    phase: "local",
    items: [{ ...plan().items[0]!, kind: "app", status: "claimed", claimId: ownerId }],
  });
  expect(await observer.isAlive!(ownerId)).toBe(true);
  expect(await observer.isAlive!(ownerId)).toBe(true);
  expect(
    (await navigator.locks.query()).pending?.filter(
      (lock) => lock.name === `t3code-update-plan-owner:${ownerId}`,
    ),
  ).toHaveLength(1);
  await owner[Symbol.asyncDispose]();
  await released.promise;
  expect(wake).toHaveBeenCalledTimes(1);
  const install = vi.fn(async () => true);
  const ports: UpdatePlanPorts = {
    claimId: observerId,
    recoveringClaims: true,
    isClaimOwnerAlive: observer.isAlive!,
    appVersion: "1.0.0",
    now: () => 0,
    ready: () => true,
    notAppliedVersion: () => null,
    resolve: () => ({ status: "ready" }),
    download: async () => true,
    waitForMaintenance: async () => {},
    maintenanceReady: () => true,
    countdown: async () => true,
    install,
    execute: async () => ({ status: "done" }),
  };
  await runUpdatePlan(store, ports);
  expect((await store.read())?.phase).toBe("paused");
  expect(install).not.toHaveBeenCalled();
  await store.change((plan) => plan && retryExecutionPlan(plan, "1.0.0", ports.resolve));
  await runUpdatePlan(store, ports);
  await runUpdatePlan(store, ports);
  expect(install).toHaveBeenCalledTimes(1);
});

it("leaves claim recovery to the existing heuristic when Web Locks are unavailable", async () => {
  await using owner = createUpdatePlanClaimOwner(randomUUID(), () => {}, undefined);
  await owner.ready;
  expect(owner.isAlive).toBeUndefined();
});
