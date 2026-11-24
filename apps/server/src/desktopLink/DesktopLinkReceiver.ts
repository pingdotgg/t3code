// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopLinkMessage,
  type DesktopLinkMessage as DesktopLinkMessageValue,
  type DesktopLinkSnapshot,
  type DesktopShellEnvironmentSnapshot,
  DesktopLinkControlMessage,
  type DesktopUpdateChannel,
  type DesktopUpdateStatusReport,
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

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

type DesktopLinkStatus = "starting" | "healthy" | "degraded" | "unavailable" | "stopped";

function messageVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}

const INITIAL_SAMPLE_DEADLINE_MS = 90_000;
const MIN_SNAPSHOT_STALE_AFTER_MS = 90_000;
const STALE_GRACE_MS = 30_000;
const DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS = 30_000;
const DEFAULT_HOST_POWER_IDLE_INTERVAL_MS = 120_000;
const STALE_CHECK_INTERVAL = Duration.seconds(30);

export class DesktopLinkDescriptorUnavailable extends Schema.TaggedError<DesktopLinkDescriptorUnavailable>()(
  "DesktopLinkDescriptorUnavailable",
  {
    mode: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop link descriptor is unavailable in '${this.mode}' mode.`;
  }
}

export class DesktopLinkProtocolMismatch extends Schema.TaggedError<DesktopLinkProtocolMismatch>()(
  "DesktopLinkProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop link protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class DesktopLinkDecodeFailed extends Schema.TaggedError<DesktopLinkDecodeFailed>()(
  "DesktopLinkDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode desktop link.";
  }
}

export class DesktopLinkStreamFailed extends Schema.TaggedError<DesktopLinkStreamFailed>()(
  "DesktopLinkStreamFailed",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop link stream on fd ${this.fd} failed.`;
  }
}

export class DesktopLinkStreamClosed extends Schema.TaggedError<DesktopLinkStreamClosed>()(
  "DesktopLinkStreamClosed",
  {
    fd: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop link stream on fd ${this.fd} closed.`;
  }
}

export class DesktopLinkStale extends Schema.TaggedError<DesktopLinkStale>()("DesktopLinkStale", {
  fd: Schema.Number,
  staleAfterMs: Schema.Number,
}) {
  override get message(): string {
    return `Desktop link on fd ${this.fd} has not updated for ${this.staleAfterMs}ms.`;
  }
}

export type DesktopLinkReceiverError =
  | DesktopLinkDescriptorUnavailable
  | DesktopLinkProtocolMismatch
  | DesktopLinkDecodeFailed
  | DesktopLinkStreamFailed
  | DesktopLinkStreamClosed;

export class DesktopLinkControlFailed extends Schema.TaggedError<DesktopLinkControlFailed>()(
  "DesktopLinkControlFailed",
  {
    fd: Schema.Number,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop link control '${this.operation}' failed on fd ${this.fd}.`;
  }
}

export class DesktopLinkControlStalled extends Schema.TaggedError<DesktopLinkControlStalled>()(
  "DesktopLinkControlStalled",
  {
    fd: Schema.Number,
    remainingBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop link control stalled on fd ${this.fd} with ${this.remainingBytes} bytes remaining.`;
  }
}

export type DesktopLinkControlError = DesktopLinkControlFailed | DesktopLinkControlStalled;

export interface DesktopLinkReceiverHealth {
  readonly status: DesktopLinkStatus;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
}

/** Moves the desktop app to `channel` and installs only `targetVersion`. */
export interface DesktopTrackSwitch {
  readonly channel: DesktopUpdateChannel;
  readonly targetVersion: string;
}

export class DesktopLinkReceiver extends Context.Service<
  DesktopLinkReceiver,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopLinkSnapshot>>;
    readonly changes: Stream.Stream<DesktopLinkSnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopLinkSnapshot>;
        readonly changes: Stream.Stream<DesktopLinkSnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly health: Effect.Effect<DesktopLinkReceiverHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: DesktopLinkReceiverHealth;
        readonly changes: Stream.Stream<DesktopLinkReceiverHealth>;
      },
      never,
      Scope.Scope
    >;
    /** Tells the desktop parent that the server accepts requests, so it can skip readiness polling. */
    readonly announceServerReady: Effect.Effect<void, DesktopLinkControlError>;
    readonly requestDesktopUpdate: (
      requestId: string,
      trackSwitch?: DesktopTrackSwitch,
    ) => Effect.Effect<void, DesktopLinkControlError>;
    readonly commitDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<void, DesktopLinkControlError>;
    readonly cancelDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<void, DesktopLinkControlError>;
    readonly desktopUpdates: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopUpdateStatusReport>;
        readonly changes: Stream.Stream<DesktopUpdateStatusReport>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/desktopLink/DesktopLinkReceiver") {}

class DesktopShellCertificatesUpdateFailed extends Schema.TaggedError<DesktopShellCertificatesUpdateFailed>()(
  "DesktopShellCertificatesUpdateFailed",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to update desktop shell TLS certificates.";
  }
}

export function makeApplyDesktopShellEnvironmentSnapshot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  let baseCertificates: Array<string> | undefined;
  return Effect.fn("resourceTelemetry.desktopLinkReceiver.applyShellEnvironment")(function* (
    message: DesktopShellEnvironmentSnapshot,
  ) {
    if (message.platform !== platform) return;
    // Node's first default-CA enumeration consults process.env, so capture it before the patch.
    if (message.environment.NODE_EXTRA_CA_CERTS !== undefined && baseCertificates === undefined) {
      // Remove only the startup extras, preserving duplicates from bundled or system trust.
      const extras = [...NodeTls.getCACertificates("extra")];
      baseCertificates = NodeTls.getCACertificates("default").filter((certificate) => {
        const index = extras.indexOf(certificate);
        if (index === -1) return true;
        extras.splice(index, 1);
        return false;
      });
    }
    applyShellEnvironment(environment, message.environment, platform);
    if (message.environment.NODE_EXTRA_CA_CERTS !== undefined) {
      yield* Effect.gen(function* () {
        const certificates = baseCertificates;
        // --use-openssl-ca roots are not enumerable; replacing the list would discard them.
        if (certificates === undefined || certificates.length === 0) {
          yield* Effect.logWarning(
            "Preserving non-enumerable TLS trust. Restart to apply updated desktop shell certificates.",
          );
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        const file = message.environment.NODE_EXTRA_CA_CERTS;
        const bundle = file ? yield* fs.readFileString(file) : undefined;
        yield* Effect.try({
          try: () => {
            const extras =
              bundle?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
            if (bundle?.trim() && extras.length === 0) {
              throw new Error("No PEM certificates found.");
            }
            NodeTls.setDefaultCACertificates([...certificates, ...extras]);
          },
          catch: (cause) => new DesktopShellCertificatesUpdateFailed({ cause }),
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to update desktop shell TLS certificates.", Cause.fail(cause)),
        ),
      );
    }
    if (message.discovered) delete environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
  });
}

const decodeMessage = Schema.decodeUnknownEffect(DesktopLinkMessage);
const encodeControlMessage = Schema.encodeEffect(Schema.fromJsonString(DesktopLinkControlMessage));
const isDescriptorUnavailable = Schema.is(DesktopLinkDescriptorUnavailable);
const isProtocolMismatch = Schema.is(DesktopLinkProtocolMismatch);
const isDecodeFailed = Schema.is(DesktopLinkDecodeFailed);
const isStreamFailed = Schema.is(DesktopLinkStreamFailed);

function isDesktopLinkContactStale(lastContactAtMs: Option.Option<number>, nowMs: number): boolean {
  return Option.exists(
    lastContactAtMs,
    (lastContact) => nowMs - lastContact >= INITIAL_SAMPLE_DEADLINE_MS,
  );
}

function resolveDesktopLinkSnapshotStaleAfterMs(
  activeIntervalMs: number,
  idleIntervalMs: number,
): number {
  return Math.max(
    MIN_SNAPSHOT_STALE_AFTER_MS,
    Math.max(activeIntervalMs, idleIntervalMs) + STALE_GRACE_MS,
  );
}

function initialDesktopLinkContactAt(
  desktopLinkFd: number | undefined,
  nowMs: number,
): Option.Option<number> {
  return desktopLinkFd === undefined ? Option.none() : Option.some(nowMs);
}

const recordDesktopLinkSampleHealth = Effect.fn(
  "resourceTelemetry.desktopLinkReceiver.recordSampleHealth",
)(function* (
  health: Ref.Ref<DesktopLinkReceiverHealth>,
  healthChanges: PubSub.PubSub<DesktopLinkReceiverHealth>,
  sampledAt: DateTime.Utc,
) {
  const next: DesktopLinkReceiverHealth = {
    status: "healthy",
    lastSampleAt: Option.some(sampledAt),
    lastError: Option.none(),
  };
  yield* Ref.set(health, next);
  yield* PubSub.publish(healthChanges, next);
});

function normalizeReceiverError(error: unknown): DesktopLinkReceiverError {
  if (
    isDescriptorUnavailable(error) ||
    isProtocolMismatch(error) ||
    isDecodeFailed(error) ||
    isStreamFailed(error)
  ) {
    return error;
  }
  return new DesktopLinkDecodeFailed({ cause: error });
}

export const writeAllToFileDescriptor = Effect.fn(
  "resourceTelemetry.desktopLinkReceiver.writeAllToFileDescriptor",
)(function* (fd: number, payload: Buffer) {
  let offset = 0;
  while (offset < payload.byteLength) {
    const written = yield* Effect.callback<number, DesktopLinkControlFailed>((resume, signal) => {
      if (signal.aborted) return;
      try {
        NodeFS.write(
          fd,
          payload,
          offset,
          payload.byteLength - offset,
          null,
          (error, bytesWritten) => {
            if (error) {
              resume(
                Effect.fail(
                  new DesktopLinkControlFailed({
                    fd,
                    operation: "write",
                    cause: error,
                  }),
                ),
              );
              return;
            }
            resume(Effect.succeed(bytesWritten));
          },
        );
      } catch (cause) {
        resume(
          Effect.fail(
            new DesktopLinkControlFailed({
              fd,
              operation: "write",
              cause,
            }),
          ),
        );
      }
    });
    yield* requireDesktopLinkWriteProgress(fd, payload.byteLength - offset, written);
    offset += written;
  }
});

export function requireDesktopLinkWriteProgress(
  fd: number,
  remainingBytes: number,
  written: number,
): Effect.Effect<void, DesktopLinkControlStalled> {
  return written > 0
    ? Effect.void
    : Effect.fail(new DesktopLinkControlStalled({ fd, remainingBytes }));
}

/** @public */
export const make = Effect.fn("resourceTelemetry.desktopLinkReceiver.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const applyShellSnapshot = makeApplyDesktopShellEnvironmentSnapshot(environment, platform);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const latest = yield* Ref.make(Option.none<DesktopLinkSnapshot>());
  const receiverStartedAt = yield* DateTime.now;
  const lastContactAtMs = yield* Ref.make(
    initialDesktopLinkContactAt(config.desktopLinkFd, DateTime.toEpochMillis(receiverStartedAt)),
  );
  const snapshotStaleAfterMs = yield* Ref.make(
    resolveDesktopLinkSnapshotStaleAfterMs(
      DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS,
      DEFAULT_HOST_POWER_IDLE_INTERVAL_MS,
    ),
  );
  const changes = yield* PubSub.sliding<DesktopLinkSnapshot>(8);
  const healthChanges = yield* PubSub.sliding<DesktopLinkReceiverHealth>(4);
  const latestUpdateReport = yield* Ref.make(Option.none<DesktopUpdateStatusReport>());
  const updateReportChanges = yield* PubSub.sliding<DesktopUpdateStatusReport>(16);
  const controlMutex = yield* Semaphore.make(1);
  const snapshotMutex = yield* Semaphore.make(1);
  const health = yield* Ref.make<DesktopLinkReceiverHealth>({
    status: config.desktopLinkFd === undefined ? "unavailable" : "starting",
    lastSampleAt: Option.none(),
    lastError:
      config.desktopLinkFd === undefined
        ? Option.some(
            new DesktopLinkDescriptorUnavailable({
              mode: config.mode,
            }).message,
          )
        : Option.none(),
  });
  const updateHealth = (
    update: (current: DesktopLinkReceiverHealth) => DesktopLinkReceiverHealth,
  ) =>
    Ref.modify(health, (current) => {
      const next = update(current);
      return [next, next];
    }).pipe(
      Effect.flatMap((next) => PubSub.publish(healthChanges, next)),
      Effect.asVoid,
    );
  const updateSampleHealth = (sampledAt: DateTime.Utc) =>
    recordDesktopLinkSampleHealth(health, healthChanges, sampledAt);

  const sendControlMessage = (message: DesktopLinkControlMessage) =>
    controlMutex.withPermits(1)(
      Effect.gen(function* () {
        const fd = config.desktopLinkControlFd;
        if (fd === undefined) return;
        const encoded = yield* encodeControlMessage(message).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopLinkControlFailed({
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
          resolveDesktopLinkSnapshotStaleAfterMs(activeIntervalMs, idleIntervalMs),
        ),
      ),
    );
  };
  if (config.desktopLinkControlFd !== undefined) {
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

  if (config.desktopLinkFd !== undefined) {
    const fd = config.desktopLinkFd;
    // The parent waits before closing; use cancellable socket reads so filesystem reads cannot block exit.
    const readable = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new NodeNet.Socket({ fd, readable: true, writable: false }),
        catch: (cause) => new DesktopLinkStreamFailed({ fd, cause }),
      }),
      (stream) =>
        Effect.sync(() => {
          stream.destroy();
        }),
    );

    const messages: Stream.Stream<DesktopLinkMessageValue, DesktopLinkReceiverError> =
      NodeStream.fromReadable<Uint8Array, DesktopLinkStreamFailed>({
        evaluate: () => readable,
        closeOnDone: true,
        onError: (cause) => new DesktopLinkStreamFailed({ fd, cause }),
      }).pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect(
          (
            value,
          ): Effect.Effect<
            DesktopLinkMessageValue,
            DesktopLinkProtocolMismatch | DesktopLinkDecodeFailed
          > => {
            const version = messageVersion(value);
            if (version !== undefined && version !== 1) {
              return Effect.fail(
                new DesktopLinkProtocolMismatch({
                  expectedVersion: 1,
                  receivedVersion: version,
                }),
              );
            }
            return decodeMessage(value).pipe(
              Effect.mapError((cause) => new DesktopLinkDecodeFailed({ cause })),
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
        if (message.type === "desktopLinkHello") {
          return recordContact.pipe(
            Effect.andThen(
              updateHealth((current): DesktopLinkReceiverHealth => ({
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
        updateHealth((current): DesktopLinkReceiverHealth => ({
          ...current,
          status: "stopped",
          lastError: Option.some(new DesktopLinkStreamClosed({ fd }).message),
        })),
      ),
      Effect.catch((error) =>
        updateHealth((current): DesktopLinkReceiverHealth => ({
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
                  return [Option.none<DesktopLinkSnapshot>(), current] as const;
                }
                const stale: DesktopLinkSnapshot = {
                  ...current.value,
                  power: { ...current.value.power, stale: true },
                };
                return [Option.some(stale), Option.some(stale)] as const;
              });
              if (Option.isNone(staleSnapshot)) {
                const lastContact = yield* Ref.get(lastContactAtMs);
                if (!isDesktopLinkContactStale(lastContact, nowMs)) return;
                const staleMessage = new DesktopLinkStale({
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
                    return [Option.none<DesktopLinkReceiverHealth>(), current] as const;
                  }
                  const next: DesktopLinkReceiverHealth = {
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
                    : Option.some(new DesktopLinkStale({ fd, staleAfterMs }).message),
              }));
              yield* PubSub.publish(changes, staleSnapshot.value);
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }

  return DesktopLinkReceiver.of({
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
    announceServerReady: sendControlMessage({ version: 1, type: "serverReady" }).pipe(
      Effect.withSpan("DesktopLinkReceiver.announceServerReady"),
    ),
    requestDesktopUpdate: Effect.fn("DesktopLinkReceiver.requestDesktopUpdate")(
      function (requestId, trackSwitch) {
        return sendControlMessage({
          version: 1,
          type: "requestDesktopUpdate",
          requestId,
          ...trackSwitch,
        });
      },
    ),
    commitDesktopUpdate: Effect.fn("DesktopLinkReceiver.commitDesktopUpdate")(function (requestId) {
      return sendControlMessage({ version: 1, type: "commitDesktopUpdate", requestId });
    }),
    cancelDesktopUpdate: Effect.fn("DesktopLinkReceiver.cancelDesktopUpdate")(function (requestId) {
      return sendControlMessage({ version: 1, type: "cancelDesktopUpdate", requestId });
    }),
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

export const layer = Layer.effect(DesktopLinkReceiver, make());

export const layerTest = (
  overrides: Partial<DesktopLinkReceiver["Service"]> = {},
): Layer.Layer<DesktopLinkReceiver> => {
  const latest = overrides.latest ?? Effect.succeedNone;
  const changes = overrides.changes ?? Stream.empty;
  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Desktop link test implementation is unavailable."),
    });
  return Layer.succeed(
    DesktopLinkReceiver,
    DesktopLinkReceiver.of({
      latest,
      changes,
      subscribe:
        overrides.subscribe ??
        latest.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes,
          })),
        ),
      health,
      subscribeHealth:
        overrides.subscribeHealth ??
        health.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes: Stream.empty,
          })),
        ),
      announceServerReady: Effect.void,
      requestDesktopUpdate: Effect.fn("DesktopLinkReceiver.requestDesktopUpdate")(function () {
        return Effect.void;
      }),
      commitDesktopUpdate: Effect.fn("DesktopLinkReceiver.commitDesktopUpdate")(function () {
        return Effect.void;
      }),
      cancelDesktopUpdate: Effect.fn("DesktopLinkReceiver.cancelDesktopUpdate")(function () {
        return Effect.void;
      }),
      desktopUpdates:
        overrides.desktopUpdates ??
        Effect.succeed({
          latest: Option.none<DesktopUpdateStatusReport>(),
          changes: Stream.empty,
        }),
      ...overrides,
    }),
  );
};
