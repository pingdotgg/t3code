import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClientRequest } from "effect/http";
import { maintainActiveSandbox, type BaseCloudSandboxDriver } from "@t3tools/cloud-sandbox";
import {
  CLOUD_SANDBOX_ACTIVITY_PATH,
  MANAGED_CLOUD_SOURCE_PORT,
  CloudSandboxActivity,
  type ManagedCloudSandboxResourceId,
  managedCloudSandboxProxyPath,
} from "@t3tools/contracts";
import * as Store from "./CloudSandboxStore.ts";
import type { ManagedCloudSandboxRoute } from "./CloudSandboxManager.ts";
import { isDeletedOrDeleting, toError, type ManagerRuntime } from "./ManagerRuntime.ts";

const decodeActivity = Schema.decodeUnknownEffect(CloudSandboxActivity);
export const makeConnections = (rt: ManagerRuntime) => {
  const {
    renewalsEnabled,
    store,
    secrets,
    transport,
    httpClient,
    controllerEnvironmentId,
    scope,
    locks,
    routes,
    workers,
    requireRecord,
    resolveProfile,
    driverFor,
    requireSandbox,
    stopWorker,
  } = rt;
  const sourceContext = Effect.fn("CloudSandboxManager.sourceContext")(function* (
    id: ManagedCloudSandboxResourceId,
    token: string,
  ) {
    const stored = yield* secrets.get(`cloud-source-${id}`).pipe(Effect.mapError(toError));
    if (Option.isNone(stored)) {
      return yield* new Store.CloudSandboxManagerError({ reason: "ownership" });
    }
    const encoder = new TextEncoder();
    const storedGrant = encoder.encode(Hex.encode(stored.value));
    const candidateGrant = encoder.encode(token);
    const tokenMatches =
      storedGrant.byteLength === candidateGrant.byteLength &&
      Mac.timingSafeEqual(storedGrant, candidateGrant);
    if (!tokenMatches) {
      return yield* new Store.CloudSandboxManagerError({ reason: "ownership" });
    }
    const record = yield* requireRecord(id);
    if (isDeletedOrDeleting(record))
      return yield* new Store.CloudSandboxManagerError({ reason: "ownership" });
    return {
      resourceId: id,
      controllerEnvironmentId,
      controllerBaseUrl: `http://127.0.0.1:${MANAGED_CLOUD_SOURCE_PORT}`,
      grantToken: token,
    };
  });

  const prepareForkSnapshot = Effect.fn("CloudSandboxManager.prepareForkSnapshot")(function* (
    initial: Store.CloudSandboxRecord,
    driver: BaseCloudSandboxDriver,
  ) {
    let record = initial;
    if (record.snapshotName === null) return record;
    const snapshotName = record.snapshotName;
    if (!driver.snapshots) return yield* new Store.CloudSandboxManagerError({ reason: "provider" });
    if (record.snapshotReady) return record;
    const source = record.parentResourceId ? yield* requireRecord(record.parentResourceId) : null;
    if (!source) return yield* new Store.CloudSandboxManagerError({ reason: "conflict" });
    const existingSnapshot = yield* driver.snapshots.get(snapshotName).pipe(
      Effect.catchIf(
        (cause) => cause.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
    if (
      existingSnapshot !== null &&
      existingSnapshot.sourceSandboxId !== (yield* requireSandbox(source))
    )
      return yield* new Store.CloudSandboxManagerError({ reason: "conflict" });
    if (existingSnapshot === null) {
      yield* driver.snapshots.capture({
        sandboxId: yield* requireSandbox(source),
        name: snapshotName,
      });
    }
    yield* driver.snapshots.waitReady(snapshotName);
    record = { ...record, snapshotReady: true };
    yield* store.save(record);
    return record;
  });

  const ensureGrantToken = Effect.fn("CloudSandboxManager.ensureGrantToken")(function* (
    resourceId: ManagedCloudSandboxResourceId,
  ) {
    const bytes = yield* secrets
      .getOrCreateRandom(`cloud-source-${resourceId}`, 32)
      .pipe(Effect.mapError(toError));
    return Hex.encode(bytes);
  });

  const connectRecordUnchecked = Effect.fn("CloudSandboxManager.connectRecord")(function* (
    initial: Store.CloudSandboxRecord,
    allowResume: boolean,
  ) {
    let record = initial;
    if (isDeletedOrDeleting(record))
      return yield* new Store.CloudSandboxManagerError({ reason: "deleted" });
    const driver = yield* driverFor(record);
    if (record.sandboxId === null) {
      record = yield* prepareForkSnapshot(record, driver);
      const sandbox = yield* driver.create({ ...record.selection, requestId: record.resourceId });
      record = { ...record, sandboxId: sandbox.sandboxId };
      yield* store.save(record);
    }
    const sandboxId = yield* requireSandbox(record);
    const grantToken = yield* ensureGrantToken(record.resourceId);
    const { apiKey } = yield* resolveProfile(record.profileId);
    const connected = yield* transport.connect({
      resourceId: record.resourceId,
      driverKind: record.driverKind,
      apiKey,
      sandboxId,
      parentSandboxId:
        record.parentResourceId === null
          ? null
          : (yield* requireRecord(record.parentResourceId)).sandboxId,
      allowResume,
      expectedEnvironmentId: record.environmentId,
      context: {
        resourceId: record.resourceId,
        controllerEnvironmentId,
        controllerBaseUrl: `http://127.0.0.1:${MANAGED_CLOUD_SOURCE_PORT}`,
        grantToken,
      },
      enableLinkedEnvironments: record.enableLinkedEnvironments,
    });
    const result: ManagedCloudSandboxRoute = {
      ...connected,
      connection: {
        sandboxId,
        driverKind: record.driverKind,
        resourceId: record.resourceId,
        controllerEnvironmentId,
        environmentId: connected.environmentId,
        label: connected.label,
        routePrefix: managedCloudSandboxProxyPath(record.resourceId),
        bearerToken: connected.bearerToken,
      },
    };
    routes.set(record.resourceId, result);
    record = {
      ...record,
      lifecycle: "active",
      power: "running",
      intent: "connected",
      environmentId: connected.environmentId,
      label: connected.label,
    };
    yield* store.save(record);
    if (record.snapshotName !== null && driver.snapshots) {
      yield* driver.snapshots.delete(record.snapshotName);
      record = { ...record, snapshotName: null };
      yield* store.save(record);
    }
    yield* stopWorker(record.resourceId);
    if (driver.keepalive && renewalsEnabled) {
      const active = httpClient
        .execute(
          HttpClientRequest.get(
            new URL(CLOUD_SANDBOX_ACTIVITY_PATH, connected.httpBaseUrl).toString(),
          ).pipe(HttpClientRequest.bearerToken(connected.bearerToken)),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 200 ? response.json : Effect.succeed({ active: false }),
          ),
          Effect.flatMap(decodeActivity),
          Effect.map((activity) => activity.active),
        );
      const worker = yield* maintainActiveSandbox(driver.keepalive, sandboxId, active, {
        autoStopMinutes: record.selection.autoStopMinutes,
      }).pipe(
        Effect.catchCause(() => Effect.logWarning("Managed cloud keepalive stopped.")),
        Effect.forkIn(scope),
      );
      workers.set(record.resourceId, worker);
    }
    return result;
  }, Effect.mapError(toError));

  const connectRecord = Effect.fn("CloudSandboxManager.connectWithCleanup")(function* (
    initial: Store.CloudSandboxRecord,
    allowResume: boolean,
  ) {
    return yield* connectRecordUnchecked(initial, allowResume).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        return Effect.gen(function* () {
          const saved = yield* store.get(initial.resourceId);
          if (Option.isNone(saved)) return;
          const current = saved.value;
          yield* stopWorker(initial.resourceId);
          routes.delete(initial.resourceId);
          yield* transport.disconnect(initial.resourceId);
          if (current.sandboxId === null) {
            yield* store.save({ ...current, lifecycle: "failed" });
            return;
          }
          // A working sandbox keeps its state, and reconcile retries its connect.
          if (initial.environmentId === null) {
            const driver = yield* driverFor(current);
            const stopped = yield* driver.stop(current.sandboxId).pipe(Effect.option);
            yield* store.save({
              ...current,
              lifecycle: "deleting",
              power: Option.isSome(stopped) ? "stopped" : current.power,
            });
          }
        }).pipe(Effect.ignore);
      }),
    );
  });

  const connectUnlocked = Effect.fn("CloudSandboxManager.connect")(
    (id: ManagedCloudSandboxResourceId, allowResume: boolean) =>
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        if (!allowResume && (record.sandboxId === null || record.environmentId === null))
          return yield* new Store.CloudSandboxManagerError({ reason: "transport" });
        if (isDeletedOrDeleting(record))
          return yield* new Store.CloudSandboxManagerError({ reason: "deleted" });
        const route = routes.get(id);
        if (route || (!allowResume && record.sandboxId !== null)) {
          const driver = yield* driverFor(record);
          const status = yield* driver
            .get(yield* requireSandbox(record))
            .pipe(Effect.mapError(toError));
          if (route) {
            if (status.state === "ready" && (yield* transport.isConnected(id))) return route;
            yield* disconnectUnlocked(id);
          }
          if (!allowResume && status.state === "stopped") {
            yield* store.save({ ...record, power: "stopped" });
            return yield* new Store.CloudSandboxManagerError({ reason: "transport" });
          }
        }
        return yield* connectRecord(record, allowResume);
      }),
  );

  const connect = Effect.fn("CloudSandboxManager.connectLocked")(
    (id: ManagedCloudSandboxResourceId) => locks.withLock(id, connectUnlocked(id, false)),
  );

  const connectResuming = Effect.fn("CloudSandboxManager.connectResuming")(
    (id: ManagedCloudSandboxResourceId) => locks.withLock(id, connectUnlocked(id, true)),
  );

  const disconnectUnlocked = Effect.fn("CloudSandboxManager.disconnect")(function* (
    id: ManagedCloudSandboxResourceId,
  ) {
    const record = yield* requireRecord(id);
    if (isDeletedOrDeleting(record)) return;
    yield* stopWorker(id);
    routes.delete(id);
    yield* transport.disconnect(id);
    yield* store.save({ ...record, intent: "disconnected" });
  });

  const disconnect = Effect.fn("CloudSandboxManager.disconnectLocked")(
    (id: ManagedCloudSandboxResourceId) => locks.withLock(id, disconnectUnlocked(id)),
  );

  const route = Effect.fn("CloudSandboxManager.route")(function* (
    id: ManagedCloudSandboxResourceId,
  ) {
    const cached = routes.get(id);
    if (!cached) return yield* new Store.CloudSandboxManagerError({ reason: "transport" });
    return cached;
  });

  return {
    prepareForkSnapshot,
    ensureGrantToken,
    sourceContext,
    connectRecord,
    connectUnlocked,
    connect,
    connectResuming,
    disconnectUnlocked,
    disconnect,
    route,
  };
};

export type ManagerConnections = ReturnType<typeof makeConnections>;
