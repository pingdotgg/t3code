import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import { CloudSandboxError, createCloudSandboxDriver } from "@t3tools/cloud-sandbox";
import type {
  CloudSandboxProfileError,
  ManagedCloudSandboxResource,
  ManagedCloudSandboxResourceId,
  SandboxProfileId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { ManagedCloudSandboxRoute } from "./CloudSandboxManager.ts";
import * as Profiles from "./CloudSandboxProfiles.ts";
import * as Store from "./CloudSandboxStore.ts";
import * as Transport from "./CloudSandboxTransport.ts";

const isManagerError = Schema.is(Store.CloudSandboxManagerError);
const isCloudSandboxError = Schema.is(CloudSandboxError);

export const toError = (cause: unknown) => {
  if (isManagerError(cause)) return cause;
  const rateLimit =
    isCloudSandboxError(cause) && cause.rateLimit !== undefined ? cause.rateLimit : undefined;
  return rateLimit === undefined
    ? new Store.CloudSandboxManagerError({ reason: "provider", cause })
    : new Store.CloudSandboxManagerError({ reason: "rate-limited", cause, rateLimit });
};

/** Profile lookup failures read as provisioning failures to workspace callers. */
export const toManagerError = (cause: CloudSandboxProfileError) =>
  new Store.CloudSandboxManagerError({
    reason: cause.reason === "budget" ? "budget" : "provider",
    cause,
  });

const publicPhase = (
  record: Store.CloudSandboxRecord,
  connected: boolean,
): ManagedCloudSandboxResource["phase"] =>
  record.lifecycle !== "active"
    ? record.lifecycle
    : record.power === "stopped"
      ? "stopped"
      : record.intent === "disconnected"
        ? "disconnected"
        : connected
          ? "connected"
          : "connecting";

export const isDeletedOrDeleting = (record: Store.CloudSandboxRecord) =>
  record.lifecycle === "deleted" || record.lifecycle === "deleting";

export const isConnectIntent = (record: Store.CloudSandboxRecord) =>
  record.lifecycle === "active" && record.power === "running" && record.intent === "connected";

// The user asked for no connection, but the provider can still stop the VM; track it for display and the cap.
export const isDisconnectedButRunning = (record: Store.CloudSandboxRecord) =>
  record.lifecycle === "active" && record.power === "running" && record.intent === "disconnected";

export const makeManagerRuntime = Effect.fn("CloudSandboxManager.makeRuntime")(function* (
  renewalsEnabled: boolean,
) {
  const store = yield* Store.CloudSandboxStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const profiles = yield* Profiles.CloudSandboxProfiles;
  const transport = yield* Transport.CloudSandboxTransport;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const controllerEnvironmentId = yield* environment.getEnvironmentId;
  const scope = yield* Scope.Scope;
  const locks = yield* KeyedLock.make<string>();
  const routes = new Map<string, ManagedCloudSandboxRoute>();
  const healthFailures = new Map<string, number>();
  const workers = new Map<string, Fiber.Fiber<void>>();

  const publicResource = (record: Store.CloudSandboxRecord): ManagedCloudSandboxResource => {
    const {
      selection: _selection,
      snapshotName: _snapshotName,
      snapshotReady: _snapshotReady,
      deletionOperationId: _deletionOperationId,
      finalSpendUsd: _finalSpendUsd,
      enableLinkedEnvironments: _enableLinkedEnvironments,
      lifecycle: _lifecycle,
      power: _power,
      intent: _intent,
      ...resource
    } = record;
    return { ...resource, phase: publicPhase(record, routes.has(record.resourceId)) };
  };

  const requireRecord = Effect.fn("CloudSandboxManager.requireRecord")(function* (
    id: ManagedCloudSandboxResourceId,
  ) {
    const found = yield* store.get(id);
    if (Option.isNone(found))
      return yield* new Store.CloudSandboxManagerError({ reason: "not-found" });
    return found.value;
  });

  const resolveProfile = (profileId: SandboxProfileId) =>
    profiles.resolve(profileId).pipe(Effect.mapError(toManagerError));

  const driverFor = Effect.fn("CloudSandboxManager.driver")(function* (
    record: Store.CloudSandboxRecord,
  ) {
    const { apiKey } = yield* resolveProfile(record.profileId);
    return yield* createCloudSandboxDriver(record.driverKind, {
      apiKey,
      httpClient,
    }).pipe(Effect.mapError(toError));
  });

  const requireSandbox = (record: Store.CloudSandboxRecord) =>
    record.sandboxId === null
      ? Effect.fail(new Store.CloudSandboxManagerError({ reason: "conflict" }))
      : Effect.succeed(record.sandboxId);

  const stopWorker = Effect.fn("CloudSandboxManager.stopWorker")(function* (id: string) {
    const worker = workers.get(id);
    if (worker) yield* Fiber.interrupt(worker);
    workers.delete(id);
  });

  return {
    renewalsEnabled,
    store,
    secrets,
    profiles,
    transport,
    httpClient,
    controllerEnvironmentId,
    scope,
    locks,
    routes,
    workers,
    healthFailures,
    publicResource,
    requireRecord,
    resolveProfile,
    driverFor,
    requireSandbox,
    stopWorker,
  };
});

export type ManagerRuntime = Effect.Success<ReturnType<typeof makeManagerRuntime>>;
