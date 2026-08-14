// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetryMessage as DesktopHostTelemetryMessageValue,
  type DesktopHostTelemetrySnapshot,
  DesktopTelemetryControlMessage,
  type DesktopUpdateStatusReport,
  type ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

const INITIAL_SAMPLE_DEADLINE_MS = 90_000;
const MIN_SNAPSHOT_STALE_AFTER_MS = 90_000;
const STALE_GRACE_MS = 30_000;
const DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS = 30_000;
const DEFAULT_HOST_POWER_IDLE_INTERVAL_MS = 120_000;
const STALE_CHECK_INTERVAL = Duration.seconds(30);

export class DesktopTelemetryDescriptorUnavailable extends Schema.TaggedErrorClass<DesktopTelemetryDescriptorUnavailable>()(
  "DesktopTelemetryDescriptorUnavailable",
  {
    mode: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop telemetry descriptor is unavailable in '${this.mode}' mode.`;
  }
}

export class DesktopTelemetryProtocolMismatch extends Schema.TaggedErrorClass<DesktopTelemetryProtocolMismatch>()(
  "DesktopTelemetryProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class DesktopTelemetryDecodeFailed extends Schema.TaggedErrorClass<DesktopTelemetryDecodeFailed>()(
  "DesktopTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode desktop telemetry.";
  }
}

export class DesktopTelemetryStreamFailed extends Schema.TaggedErrorClass<DesktopTelemetryStreamFailed>()(
  "DesktopTelemetryStreamFailed",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop telemetry stream on fd ${this.fd} failed.`;
  }
}

export class DesktopTelemetryStreamClosed extends Schema.TaggedErrorClass<DesktopTelemetryStreamClosed>()(
  "DesktopTelemetryStreamClosed",
  {
    fd: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry stream on fd ${this.fd} closed.`;
  }
}

export class DesktopTelemetryStale extends Schema.TaggedErrorClass<DesktopTelemetryStale>()(
  "DesktopTelemetryStale",
  {
    fd: Schema.Number,
    staleAfterMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry on fd ${this.fd} has not updated for ${this.staleAfterMs}ms.`;
  }
}

export type DesktopTelemetryReceiverError =
  | DesktopTelemetryDescriptorUnavailable
  | DesktopTelemetryProtocolMismatch
  | DesktopTelemetryDecodeFailed
  | DesktopTelemetryStreamFailed
  | DesktopTelemetryStreamClosed;

export class DesktopTelemetryControlFailed extends Schema.TaggedErrorClass<DesktopTelemetryControlFailed>()(
  "DesktopTelemetryControlFailed",
  {
    fd: Schema.Number,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop telemetry control '${this.operation}' failed on fd ${this.fd}.`;
  }
}

export class DesktopTelemetryControlStalled extends Schema.TaggedErrorClass<DesktopTelemetryControlStalled>()(
  "DesktopTelemetryControlStalled",
  {
    fd: Schema.Number,
    remainingBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry control stalled on fd ${this.fd} with ${this.remainingBytes} bytes remaining.`;
  }
}

export type DesktopTelemetryControlError =
  | DesktopTelemetryControlFailed
  | DesktopTelemetryControlStalled;

export interface DesktopTelemetryReceiverHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
}

export class DesktopTelemetryReceiver extends Context.Service<
  DesktopTelemetryReceiver,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
    readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopHostTelemetrySnapshot>;
        readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly health: Effect.Effect<DesktopTelemetryReceiverHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: DesktopTelemetryReceiverHealth;
        readonly changes: Stream.Stream<DesktopTelemetryReceiverHealth>;
      },
      never,
      Scope.Scope
    >;
    readonly setDiagnosticsDemand: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
    /** Asks the desktop app supervising this server to update itself. The
        desktop answers with desktopUpdateStatus reports carrying the same
        requestId. */
    readonly requestDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
    /** Latest desktop update state report plus subsequent reports. The
        desktop replays its latest report when the backend attaches, so this
        is populated shortly after startup on desktop-managed servers. */
    readonly desktopUpdates: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopUpdateStatusReport>;
        readonly changes: Stream.Stream<DesktopUpdateStatusReport>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/resourceTelemetry/DesktopTelemetryReceiver") {}

const decodeMessage = Schema.decodeUnknownEffect(DesktopHostTelemetryMessage);
const encodeControlMessage = Schema.encodeEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);
const isDescriptorUnavailable = Schema.is(DesktopTelemetryDescriptorUnavailable);
const isProtocolMismatch = Schema.is(DesktopTelemetryProtocolMismatch);
const isDecodeFailed = Schema.is(DesktopTelemetryDecodeFailed);
const isStreamFailed = Schema.is(DesktopTelemetryStreamFailed);

export function isDesktopTelemetryContactStale(
  lastContactAtMs: Option.Option<number>,
  nowMs: number,
): boolean {
  return Option.exists(
    lastContactAtMs,
    (lastContact) => nowMs - lastContact >= INITIAL_SAMPLE_DEADLINE_MS,
  );
}

export function resolveDesktopTelemetrySnapshotStaleAfterMs(
  activeIntervalMs: number,
  idleIntervalMs: number,
): number {
  return Math.max(
    MIN_SNAPSHOT_STALE_AFTER_MS,
    Math.max(activeIntervalMs, idleIntervalMs) + STALE_GRACE_MS,
  );
}

export function initialDesktopTelemetryContactAt(
  desktopTelemetryFd: number | undefined,
  nowMs: number,
): Option.Option<number> {
  return desktopTelemetryFd === undefined ? Option.none() : Option.some(nowMs);
}

export const recordDesktopTelemetrySampleHealth = Effect.fn(
  "resourceTelemetry.desktopTelemetryReceiver.recordSampleHealth",
)(function* (
  health: Ref.Ref<DesktopTelemetryReceiverHealth>,
  healthChanges: PubSub.PubSub<DesktopTelemetryReceiverHealth>,
  sampledAt: DateTime.Utc,
) {
  const next: DesktopTelemetryReceiverHealth = {
    status: "healthy",
    lastSampleAt: Option.some(sampledAt),
    lastError: Option.none(),
  };
  yield* Ref.set(health, next);
  yield* PubSub.publish(healthChanges, next);
});

function normalizeReceiverError(error: unknown): DesktopTelemetryReceiverError {
  if (
    isDescriptorUnavailable(error) ||
    isProtocolMismatch(error) ||
    isDecodeFailed(error) ||
    isStreamFailed(error)
  ) {
    return error;
  }
  return new DesktopTelemetryDecodeFailed({ cause: error });
}

function messageVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}

export const writeAllToFileDescriptor = Effect.fn(
  "resourceTelemetry.desktopTelemetryReceiver.writeAllToFileDescriptor",
)(function* (fd: number, payload: Buffer) {
  let offset = 0;
  while (offset < payload.byteLength) {
    const written = yield* Effect.callback<number, DesktopTelemetryControlFailed>(
      (resume, signal) => {
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
                    new DesktopTelemetryControlFailed({
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
              new DesktopTelemetryControlFailed({
                fd,
                operation: "write",
                cause,
              }),
            ),
          );
        }
      },
    );
    yield* requireDesktopTelemetryWriteProgress(fd, payload.byteLength - offset, written);
    offset += written;
  }
});

export function requireDesktopTelemetryWriteProgress(
  fd: number,
  remainingBytes: number,
  written: number,
): Effect.Effect<void, DesktopTelemetryControlStalled> {
  return written > 0
    ? Effect.void
    : Effect.fail(new DesktopTelemetryControlStalled({ fd, remainingBytes }));
}

export const make = Effect.fn("resourceTelemetry.desktopTelemetryReceiver.make")(function* () {
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
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
    const readable = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          NodeFS.createReadStream("", {
            fd,
            autoClose: true,
          }),
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
            Option.Option<DesktopHostTelemetryMessageValue>,
            DesktopTelemetryProtocolMismatch
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
            // An undecodable line is logged and skipped instead of failing
            // the stream: failing would stop desktop telemetry for the
            // whole process lifetime over one unknown message shape.
            return decodeMessage(value).pipe(
              Effect.map(Option.some),
              Effect.catchCause((cause) =>
                Effect.logWarning("Skipping undecodable desktop telemetry message", {
                  cause: String(cause),
                }).pipe(Effect.as(Option.none<DesktopHostTelemetryMessageValue>())),
              ),
            );
          },
        ),
        Stream.filterMap(
          Option.match({
            onNone: () => Result.failVoid,
            onSome: Result.succeed,
          }),
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
              updateHealth(
                (current): DesktopTelemetryReceiverHealth => ({
                  ...current,
                  status: "healthy",
                  lastError: Option.none(),
                }),
              ),
            ),
          );
        }

        // Not a resource sample: do not touch `latest` or sample health.
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
        updateHealth(
          (current): DesktopTelemetryReceiverHealth => ({
            ...current,
            status: "stopped",
            lastError: Option.some(new DesktopTelemetryStreamClosed({ fd }).message),
          }),
        ),
      ),
      Effect.catch((error) =>
        updateHealth(
          (current): DesktopTelemetryReceiverHealth => ({
            ...current,
            status: "degraded",
            lastError: Option.some(error.message),
          }),
        ),
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
    requestDesktopUpdate: (requestId) =>
      sendControlMessage({
        version: 1,
        type: "requestDesktopUpdate",
        requestId,
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

export const layer = Layer.effect(DesktopTelemetryReceiver, make());

export const layerTest = (
  overrides: Partial<DesktopTelemetryReceiver["Service"]> = {},
): Layer.Layer<DesktopTelemetryReceiver> => {
  const latest = overrides.latest ?? Effect.succeedNone;
  const changes = overrides.changes ?? Stream.empty;
  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Desktop telemetry test implementation is unavailable."),
    });
  return Layer.succeed(
    DesktopTelemetryReceiver,
    DesktopTelemetryReceiver.of({
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
      setDiagnosticsDemand: () => Effect.void,
      requestDesktopUpdate: () => Effect.void,
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
