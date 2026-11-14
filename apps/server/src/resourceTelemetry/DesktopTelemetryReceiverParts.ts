// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetryMessage as DesktopHostTelemetryMessageValue,
  type DesktopHostTelemetrySnapshot,
  type DesktopShellEnvironmentSnapshot,
  DesktopTelemetryControlMessage,
  type DesktopUpdateChannel,
  type DesktopUpdateStatusReport,
  type ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyShellEnvironment } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";

import { eventVersion as messageVersion } from "./NativeTelemetryClient.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";
import type { DesktopTelemetryReceiverError, DesktopTelemetryReceiverHealth } from "./DesktopTelemetryReceiver.ts";
import { DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS, DEFAULT_HOST_POWER_IDLE_INTERVAL_MS, DesktopTelemetryControlFailed, DesktopTelemetryDecodeFailed, DesktopTelemetryDescriptorUnavailable, DesktopTelemetryProtocolMismatch, DesktopTelemetryReceiver, DesktopTelemetryStale, DesktopTelemetryStreamClosed, DesktopTelemetryStreamFailed, INITIAL_SAMPLE_DEADLINE_MS, STALE_CHECK_INTERVAL, decodeMessage, encodeControlMessage, initialDesktopTelemetryContactAt, isDesktopTelemetryContactStale, makeApplyDesktopShellEnvironmentSnapshot, normalizeReceiverError, recordDesktopTelemetrySampleHealth, resolveDesktopTelemetrySnapshotStaleAfterMs, writeAllToFileDescriptor } from "./DesktopTelemetryReceiver.ts";

export const make = Effect.fn("resourceTelemetry.desktopTelemetryReceiver.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const applyShellSnapshot = makeApplyDesktopShellEnvironmentSnapshot(environment, platform);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const latest = yield* Ref.make(Option.none<DesktopHostTelemetrySnapshot>());
  const receiverStartedAt = yield* DateTime.now;
  const lastContactAtMs = yield* Ref.make(
    initialDesktopTelemetryContactAt(
      config.desktopTelemetryFd,
      DateTime.toEpochMillis(receiverStartedAt),
    ),
  );
  const snapshotStaleAfterMs = yield* Ref.make(
    resolveDesktopTelemetrySnapshotStaleAfterMs(
      DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS,
      DEFAULT_HOST_POWER_IDLE_INTERVAL_MS,
    ),
  );
  const changes = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(8);
  const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
  const latestUpdateReport = yield* Ref.make(Option.none<DesktopUpdateStatusReport>());
  const updateReportChanges = yield* PubSub.sliding<DesktopUpdateStatusReport>(16);
  const controlMutex = yield* Semaphore.make(1);
  const snapshotMutex = yield* Semaphore.make(1);
  const health = yield* Ref.make<DesktopTelemetryReceiverHealth>({
    status: config.desktopTelemetryFd === undefined ? "unavailable" : "starting",
    lastSampleAt: Option.none(),
    lastError:
      config.desktopTelemetryFd === undefined
        ? Option.some(
            new DesktopTelemetryDescriptorUnavailable({
              mode: config.mode,
            }).message,
          )
        : Option.none(),
  });
  const updateHealth = (
    update: (current: DesktopTelemetryReceiverHealth) => DesktopTelemetryReceiverHealth,
  ) =>
    Ref.modify(health, (current) => {
      const next = update(current);
      return [next, next];
    }).pipe(
      Effect.flatMap((next) => PubSub.publish(healthChanges, next)),
      Effect.asVoid,
    );
  const updateSampleHealth = (sampledAt: DateTime.Utc) =>
    recordDesktopTelemetrySampleHealth(health, healthChanges, sampledAt);

  const sendControlMessage = (message: DesktopTelemetryControlMessage) =>
    controlMutex.withPermits(1)(
      Effect.gen(function* () {
        const fd = config.desktopTelemetryControlFd;
        if (fd === undefined) return;
        const encoded = yield* encodeControlMessage(message).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTelemetryControlFailed({
                fd,
                operation: "encode",
                cause,
              }),
          ),
        );
        yield* writeAllToFileDescriptor(fd, Buffer.from(`${encoded}\n`)).pipe(
          Effect.tapError((error) =>
            updateHealth((current) => ({
              ...current,
              status: "degraded",
              lastError: Option.some(error.message),
            })),
          ),
        );
      }),
    );
  const setDiagnosticsDemand: DesktopTelemetryReceiver["Service"]["setDiagnosticsDemand"] = (
    enabled,
  ) =>
    sendControlMessage({
      version: 1,
      type: "setDiagnosticsDemand",
      enabled,
    });

  const sendHostPowerIntervals = (
    settings: Parameters<typeof resolveServerBackgroundActivitySettings>[0],
  ) => {
    const resolved = resolveServerBackgroundActivitySettings(settings);
    const activeIntervalMs = Math.max(
      1,
      Math.round(Duration.toMillis(resolved.hostPowerMonitorActiveInterval)),
    );
    const idleIntervalMs = Math.max(
      1,
      Math.round(Duration.toMillis(resolved.hostPowerMonitorIdleInterval)),
    );
    return sendControlMessage({
      version: 1,
      type: "setHostPowerIntervals",
      activeIntervalMs,
      idleIntervalMs,
    }).pipe(
      Effect.andThen(
        Ref.set(
          snapshotStaleAfterMs,
          resolveDesktopTelemetrySnapshotStaleAfterMs(activeIntervalMs, idleIntervalMs),
        ),
      ),
    );
  };
  if (config.desktopTelemetryControlFd !== undefined) {
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const settings = yield* serverSettings.getSettings;
    yield* sendHostPowerIntervals(settings).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to configure desktop host-power intervals", {
          cause: String(cause),
        }),
      ),
    );
    yield* settingsChanges.pipe(
      Stream.runForEach((settings) =>
        sendHostPowerIntervals(settings).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to update desktop host-power intervals", {
              cause: String(cause),
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }

  if (config.desktopTelemetryFd !== undefined) {
    const fd = config.desktopTelemetryFd;
    // The parent waits before closing; use cancellable socket reads so filesystem reads cannot block exit.
    const readable = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new NodeNet.Socket({ fd, readable: true, writable: false }),
        catch: (cause) => new DesktopTelemetryStreamFailed({ fd, cause }),
      }),
      (stream) =>
        Effect.sync(() => {
          stream.destroy();
        }),
    );

    const messages: Stream.Stream<DesktopHostTelemetryMessageValue, DesktopTelemetryReceiverError> =
      NodeStream.fromReadable<Uint8Array, DesktopTelemetryStreamFailed>({
        evaluate: () => readable,
        closeOnDone: true,
        onError: (cause) => new DesktopTelemetryStreamFailed({ fd, cause }),
      }).pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect(
          (
            value,
          ): Effect.Effect<
            DesktopHostTelemetryMessageValue,
            DesktopTelemetryProtocolMismatch | DesktopTelemetryDecodeFailed
          > => {
            const version = messageVersion(value);
            if (version !== undefined && version !== 1) {
              return Effect.fail(
                new DesktopTelemetryProtocolMismatch({
                  expectedVersion: 1,
                  receivedVersion: version,
                }),
              );
            }
            return decodeMessage(value).pipe(
              Effect.mapError((cause) => new DesktopTelemetryDecodeFailed({ cause })),
            );
          },
        ),
        Stream.mapError(normalizeReceiverError),
      );

    yield* messages.pipe(
      Stream.runForEach((message) => {
        const recordContact = DateTime.now.pipe(
          Effect.flatMap((now) =>
            Ref.set(lastContactAtMs, Option.some(DateTime.toEpochMillis(now))),
          ),
        );
        if (message.type === "desktopTelemetryHello") {
          return recordContact.pipe(
            Effect.andThen(
              updateHealth((current): DesktopTelemetryReceiverHealth => ({
                ...current,
                status: "healthy",
                lastError: Option.none(),
              })),
            ),
          );
        }

        if (message.type === "shellEnvironment") {
          return recordContact.pipe(Effect.andThen(applyShellSnapshot(message)));
        }

        if (message.type === "desktopUpdateStatus") {
          return recordContact.pipe(
            Effect.andThen(Ref.set(latestUpdateReport, Option.some(message))),
            Effect.andThen(PubSub.publish(updateReportChanges, message)),
            Effect.asVoid,
          );
        }

        const sampledAt = DateTime.makeUnsafe(message.sampledAtUnixMs);
        return snapshotMutex.withPermits(1)(
          recordContact.pipe(
            Effect.andThen(Ref.set(latest, Option.some(message))),
            Effect.andThen(updateSampleHealth(sampledAt)),
            Effect.andThen(PubSub.publish(changes, message)),
            Effect.asVoid,
          ),
        );
      }),
      Effect.andThen(
        updateHealth((current): DesktopTelemetryReceiverHealth => ({
          ...current,
          status: "stopped",
          lastError: Option.some(new DesktopTelemetryStreamClosed({ fd }).message),
        })),
      ),
      Effect.catch((error) =>
        updateHealth((current): DesktopTelemetryReceiverHealth => ({
          ...current,
          status: "degraded",
          lastError: Option.some(error.message),
        })),
      ),
      Effect.forkScoped,
    );

    yield* Effect.forever(
      Effect.sleep(STALE_CHECK_INTERVAL).pipe(
        Effect.andThen(
          snapshotMutex.withPermits(1)(
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const nowMs = DateTime.toEpochMillis(now);
              const staleAfterMs = yield* Ref.get(snapshotStaleAfterMs);
              const staleSnapshot = yield* Ref.modify(latest, (current) => {
                if (
                  Option.isNone(current) ||
                  current.value.power.stale ||
                  nowMs - current.value.sampledAtUnixMs < staleAfterMs
                ) {
                  return [Option.none<DesktopHostTelemetrySnapshot>(), current] as const;
                }
                const stale: DesktopHostTelemetrySnapshot = {
                  ...current.value,
                  power: { ...current.value.power, stale: true },
                };
                return [Option.some(stale), Option.some(stale)] as const;
              });
              if (Option.isNone(staleSnapshot)) {
                const lastContact = yield* Ref.get(lastContactAtMs);
                if (!isDesktopTelemetryContactStale(lastContact, nowMs)) return;
                const staleMessage = new DesktopTelemetryStale({
                  fd,
                  staleAfterMs: INITIAL_SAMPLE_DEADLINE_MS,
                }).message;
                const changed = yield* Ref.modify(health, (current) => {
                  if (
                    current.status === "stopped" ||
                    Option.isSome(current.lastSampleAt) ||
                    (current.status === "degraded" &&
                      Option.contains(current.lastError, staleMessage))
                  ) {
                    return [Option.none<DesktopTelemetryReceiverHealth>(), current] as const;
                  }
                  const next: DesktopTelemetryReceiverHealth = {
                    ...current,
                    status: "degraded",
                    lastError: Option.some(staleMessage),
                  };
                  return [Option.some(next), next] as const;
                });
                if (Option.isSome(changed)) {
                  yield* PubSub.publish(healthChanges, changed.value);
                }
                return;
              }
              yield* updateHealth((currentHealth) => ({
                ...currentHealth,
                status: currentHealth.status === "stopped" ? "stopped" : "degraded",
                lastError:
                  currentHealth.status === "stopped"
                    ? currentHealth.lastError
                    : Option.some(new DesktopTelemetryStale({ fd, staleAfterMs }).message),
              }));
              yield* PubSub.publish(changes, staleSnapshot.value);
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }

  return DesktopTelemetryReceiver.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    subscribe: snapshotMutex.withPermits(1)(
      Effect.gen(function* () {
        const initial = yield* Ref.get(latest);
        const subscription = yield* PubSub.subscribe(changes);
        return {
          latest: initial,
          changes: Stream.fromSubscription(subscription),
        };
      }),
    ),
    health: Ref.get(health),
    subscribeHealth: subscribeBeforeSnapshotWithoutMutex(healthChanges, Ref.get(health)),
    setDiagnosticsDemand,
    requestDesktopUpdate: Effect.fn("DesktopTelemetryReceiver.requestDesktopUpdate")(
      function (requestId, trackSwitch) {
        return sendControlMessage({
          version: 1,
          type: "requestDesktopUpdate",
          requestId,
          ...trackSwitch,
        });
      },
    ),
    commitDesktopUpdate: Effect.fn("DesktopTelemetryReceiver.commitDesktopUpdate")(
      function (requestId) {
        return sendControlMessage({ version: 1, type: "commitDesktopUpdate", requestId });
      },
    ),
    cancelDesktopUpdate: Effect.fn("DesktopTelemetryReceiver.cancelDesktopUpdate")(
      function (requestId) {
        return sendControlMessage({ version: 1, type: "cancelDesktopUpdate", requestId });
      },
    ),
    desktopUpdates: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(updateReportChanges);
      const initial = yield* Ref.get(latestUpdateReport);
      return {
        latest: initial,
        changes: Stream.fromSubscription(subscription),
      };
    }),
  });
});

