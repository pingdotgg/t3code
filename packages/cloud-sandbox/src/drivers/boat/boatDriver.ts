import type { BoatApiClient, BoatApiError } from "@t3tools/boat";
import { BOAT_SANDBOX_HOURLY_USD, BoatSandboxSize } from "@t3tools/contracts";
import { createBoatRecording } from "./recording.ts";
import * as Schedule from "effect/Schedule";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CloudSandboxError, type BaseCloudSandboxDriver } from "../../driver.ts";

const decodeSize = Schema.decodeUnknownEffect(BoatSandboxSize);
const isBoatSandboxSize = Schema.is(BoatSandboxSize);
const mapError = (cause: BoatApiError) =>
  new CloudSandboxError({
    reason:
      cause.status === 404
        ? "not-found"
        : cause.status === 401
          ? "authentication"
          : cause.status === 403
            ? "permission"
            : "unavailable",
    cause,
    ...(cause.rateLimit ? { rateLimit: cause.rateLimit } : {}),
  });
const mapDetails = (sandbox: Effect.Success<ReturnType<BoatApiClient["getSandbox"]>>) => ({
  ...sandbox,
  driverKind: "boat" as const,
});

export function createBoatCloudSandboxDriver(client: BoatApiClient): BaseCloudSandboxDriver {
  const mapSnapshot = (snapshot: Effect.Success<ReturnType<BoatApiClient["getSnapshot"]>>) => ({
    name: snapshot.name,
    state: snapshot.status,
    sourceSandboxId: snapshot.sourceSandboxId,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  });
  const mapDeletion = (
    operation: Effect.Success<ReturnType<BoatApiClient["getDeletionOperation"]>>,
  ) => ({
    operationId: operation.id,
    sandboxId: operation.targetId,
    state: operation.status,
  });
  const getSnapshot = (name: string) =>
    client.getSnapshot(name).pipe(Effect.map(mapSnapshot), Effect.mapError(mapError));
  const get = (id: string) =>
    client.getSandbox(id).pipe(Effect.map(mapDetails), Effect.mapError(mapError));
  return {
    kind: "boat",
    rootAccess: true,
    pricing: {
      hourlyUsd: (size) => (isBoatSandboxSize(size) ? BOAT_SANDBOX_HOURLY_USD[size] : null),
    },
    list: () =>
      client.listSandboxes().pipe(
        Effect.map((sandboxes) => sandboxes.map(mapDetails)),
        Effect.mapError(mapError),
      ),
    get,
    create: Effect.fn("BoatCloudSandboxDriver.create")(function* (input) {
      const size = yield* decodeSize(input.size ?? "default").pipe(
        Effect.mapError((cause) => new CloudSandboxError({ reason: "configuration", cause })),
      );
      return yield* client
        .createSandbox({
          name: input.name,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          size,
          ...(input.autoStopMinutes === undefined
            ? {}
            : { autoStopMinutes: input.autoStopMinutes }),
          ...(input.template === undefined ? {} : { template: input.template }),
        })
        .pipe(Effect.map(mapDetails), Effect.mapError(mapError));
    }),
    resume: (id) =>
      client.resumeSandbox(id).pipe(Effect.map(mapDetails), Effect.mapError(mapError)),
    stop: (id) => client.stopSandbox(id).pipe(Effect.map(mapDetails), Effect.mapError(mapError)),
    delete: (id) => client.deleteSandbox(id).pipe(Effect.mapError(mapError)),
    registerSshKey: Effect.fn("BoatCloudSandboxDriver.registerSshKey")(function* (id, publicKey) {
      const ssh = yield* client.addSshKey(id, publicKey).pipe(Effect.mapError(mapError));
      let hostname = ssh.machineIp;
      let port = 22;
      if (ssh.sshEndpoint) {
        const endpoint = yield* Effect.try({
          try: () => new URL(`ssh://${ssh.sshEndpoint}`),
          catch: (cause) => new CloudSandboxError({ reason: "configuration", cause }),
        });
        hostname = endpoint.hostname;
        port = Number(endpoint.port || 22);
      }
      if (!hostname || !ssh.hostKey)
        return yield* new CloudSandboxError({
          reason: "configuration",
          cause: new Error("Boat did not return an SSH endpoint and host key."),
        });
      return {
        target: { alias: `boat-${id}`, hostname, port, username: ssh.sshUser },
        hostKey: ssh.hostKey,
      };
    }),
    snapshots: {
      capture: (input) =>
        client.captureSnapshot(input).pipe(Effect.map(mapSnapshot), Effect.mapError(mapError)),
      get: getSnapshot,
      delete: (name) => client.deleteSnapshot(name).pipe(Effect.mapError(mapError)),
      waitReady: Effect.fn("BoatCloudSandboxDriver.snapshot.waitReady")(function* (name) {
        return yield* getSnapshot(name).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1500 millis"),
            while: (snapshot) => snapshot.state === "saving",
          }),
          Effect.filterOrFail(
            (snapshot) => snapshot.state === "ready",
            () =>
              new CloudSandboxError({
                reason: "unavailable",
                cause: new Error("Fresh snapshot capture failed."),
              }),
          ),
          Effect.timeout("10 minutes"),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new CloudSandboxError({ reason: "unavailable", cause })),
          }),
        );
      }),
    },
    deletion: {
      start: (id) =>
        client.beginDeleteSandbox(id).pipe(Effect.map(mapDeletion), Effect.mapError(mapError)),
      get: (id) =>
        client.getDeletionOperation(id).pipe(Effect.map(mapDeletion), Effect.mapError(mapError)),
      wait: (id) =>
        client.waitDeletion(id).pipe(Effect.map(mapDeletion), Effect.mapError(mapError)),
    },
    usage: {
      getUsage: Effect.fn("BoatCloudSandboxDriver.getUsage")(function* (id) {
        const usage = yield* client.getUsage(id).pipe(Effect.mapError(mapError));
        return {
          sandboxId: usage.sandboxId,
          listRateUsdPerHour: (3600 * usage.billingMultiplier) / usage.secondsPerDollar,
          billableSeconds: usage.seconds,
          listValueUsd: usage.dollars,
          running: usage.running,
          since: usage.since,
          until: usage.until,
        };
      }),
    },
    recording: createBoatRecording(client),
    resizing: {
      mode: "restart",
      resize: Effect.fn("BoatCloudSandboxDriver.resize")(function* (id, inputSize) {
        const size = yield* decodeSize(inputSize).pipe(
          Effect.mapError((cause) => new CloudSandboxError({ reason: "configuration", cause })),
        );
        const stopped = yield* client.stopSandbox(id).pipe(Effect.mapError(mapError));
        if (stopped.state !== "stopped")
          yield* get(id).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1500 millis"),
              while: (sandbox) => sandbox.state !== "stopped",
            }),
            Effect.timeout("10 minutes"),
            Effect.catchTags({
              TimeoutError: (cause) =>
                Effect.fail(new CloudSandboxError({ reason: "unavailable", cause })),
            }),
          );
        yield* client.resumeSandbox(id, size).pipe(Effect.mapError(mapError));
        return yield* get(id).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1500 millis"),
            while: (sandbox) => sandbox.state === "starting",
          }),
          Effect.filterOrFail(
            (sandbox) => sandbox.state === "ready",
            () =>
              new CloudSandboxError({
                reason: "unavailable",
                cause: new Error("Sandbox did not become ready after resizing."),
              }),
          ),
          Effect.timeout("10 minutes"),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new CloudSandboxError({ reason: "unavailable", cause })),
          }),
        );
      }),
    },
    forking: {
      forkSandbox: Effect.fn("BoatCloudSandboxDriver.fork")(function* (id, options) {
        const size =
          options?.size === undefined
            ? undefined
            : yield* decodeSize(options.size).pipe(
                Effect.mapError(
                  (cause) => new CloudSandboxError({ reason: "configuration", cause }),
                ),
              );
        return yield* client
          .forkSandbox(id, {
            ...(options?.name === undefined ? {} : { name: options.name }),
            ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
            ...(options?.autoStopMinutes === undefined
              ? {}
              : { autoStopMinutes: options.autoStopMinutes }),
            ...(size === undefined ? {} : { size }),
          })
          .pipe(Effect.map(mapDetails), Effect.mapError(mapError));
      }),
    },
    streaming: {
      getBrowserStreamSession: (id) =>
        client.getDesktopUrl(id, { viewMode: "browser" }).pipe(Effect.mapError(mapError)),
      getDesktopStreamSession: (id, theme) =>
        client
          .getDesktopUrl(id, theme === undefined ? {} : { theme })
          .pipe(Effect.mapError(mapError)),
    },
    keepalive: {
      extendAutoStop: (id, hours) =>
        client.extendAutoStop(id, hours).pipe(Effect.map(mapDetails), Effect.mapError(mapError)),
    },
    hosting: {
      protectedAccess: true,
      exposePort: (id, port, isPublic) =>
        client.exposePort(id, port, isPublic).pipe(
          Effect.map((result) => ({
            port: result.port,
            url: result.url,
            isPublic: !result.isProtected,
          })),
          Effect.mapError(mapError),
        ),
    },
  };
}
