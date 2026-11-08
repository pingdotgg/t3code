import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ManagedCloudSandboxResourceId } from "@t3tools/contracts";
import * as Store from "./CloudSandboxStore.ts";
import {
  isConnectIntent,
  isDisconnectedButRunning,
  toError,
  type ManagerRuntime,
} from "./ManagerRuntime.ts";
import type { ManagerAllocation } from "./ManagerAllocation.ts";
import type { ManagerConnections } from "./ManagerConnections.ts";

const HEALTH_FAILURES_BEFORE_RECONNECT = 2;
export const makeReconciler = (
  rt: ManagerRuntime,
  connections: ManagerConnections,
  allocation: ManagerAllocation,
) => {
  const {
    store,
    locks,
    routes,
    healthFailures,
    transport,
    requireRecord,
    requireSandbox,
    driverFor,
    stopWorker,
  } = rt;
  const { connectRecord, connectUnlocked } = connections;
  const { release } = allocation;
  const checkRoute = Effect.fn("CloudSandboxManager.checkRoute")(function* (
    record: Store.CloudSandboxRecord,
  ) {
    const id = record.resourceId;
    const sandboxId = yield* requireSandbox(record);
    const status = yield* driverFor(record).pipe(
      Effect.flatMap((driver) => driver.get(sandboxId).pipe(Effect.mapError(toError))),
      Effect.option,
    );
    if (Option.isNone(status)) return;
    if (status.value.state === "stopped") {
      healthFailures.delete(id);
      yield* stopWorker(id);
      routes.delete(id);
      yield* transport.disconnect(id);
      yield* store.save({ ...record, power: "stopped" });
      return;
    }
    if (status.value.state !== "ready") return;
    const connected = yield* transport.isConnected(id).pipe(Effect.orElseSucceed(() => false));
    if (connected) {
      healthFailures.delete(id);
      return;
    }
    const failures = (healthFailures.get(id) ?? 0) + 1;
    if (failures < HEALTH_FAILURES_BEFORE_RECONNECT) {
      healthFailures.set(id, failures);
      return;
    }
    healthFailures.delete(id);
    yield* stopWorker(id);
    routes.delete(id);
    yield* transport.disconnect(id);
    yield* connectRecord(record, false);
  });

  /** Returns true when the record must be released, which takes its own lock. */
  const observePower = Effect.fn("CloudSandboxManager.observePower")(function* (
    record: Store.CloudSandboxRecord,
  ) {
    const sandboxId = yield* requireSandbox(record);
    const driver = yield* driverFor(record);
    const status = yield* driver.get(sandboxId).pipe(Effect.option);
    if (Option.isSome(status) && status.value.state === "stopped")
      yield* store.save({ ...record, power: "stopped" });
  });

  const reconcileLocked = Effect.fn("CloudSandboxManager.reconcileLocked")(function* (
    id: ManagedCloudSandboxResourceId,
  ) {
    const record = yield* requireRecord(id);
    if (record.lifecycle === "deleting") return true;
    if (record.lifecycle === "allocating" && record.sandboxId === null) {
      yield* store.save({ ...record, lifecycle: "failed" });
      return false;
    }
    if (
      record.lifecycle === "allocating" &&
      record.sandboxId !== null &&
      record.environmentId === null
    ) {
      yield* connectRecord(record, false);
      return false;
    }
    if (routes.has(id)) {
      yield* checkRoute(record);
      return false;
    }
    if (isConnectIntent(record)) yield* connectUnlocked(id, false);
    else if (isDisconnectedButRunning(record)) yield* observePower(record);
    return false;
  });

  const reconcileOne = Effect.fn("CloudSandboxManager.reconcileOne")(function* (
    id: ManagedCloudSandboxResourceId,
  ) {
    const releasing = yield* locks.withLock(id, reconcileLocked(id));
    if (releasing) yield* release(id);
  });

  const reconcile = store.list.pipe(
    Effect.flatMap((records) =>
      Effect.forEach(
        records.filter(
          (record) =>
            record.lifecycle === "allocating" ||
            record.lifecycle === "deleting" ||
            isConnectIntent(record) ||
            isDisconnectedButRunning(record),
        ),
        (record) => reconcileOne(record.resourceId).pipe(Effect.ignore),
        // A fork holds its resource lock for minutes and must not stall the other sandboxes.
        { concurrency: 8 },
      ),
    ),
    Effect.asVoid,
  );

  return { reconcile };
};
