// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetryMessage as DesktopHostTelemetryMessageValue,
  type DesktopHostTelemetrySnapshot,
  DesktopTelemetryControlMessage,
  type ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";

import { ServerConfig } from "../config.ts";

const STALE_AFTER_MS = 90_000;
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

export interface DesktopTelemetryReceiverHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
}

export interface DesktopTelemetryReceiverShape {
  readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
  readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
  readonly health: Effect.Effect<DesktopTelemetryReceiverHealth>;
  readonly healthChanges: Stream.Stream<DesktopTelemetryReceiverHealth>;
  readonly setDiagnosticsDemand: (
    enabled: boolean,
  ) => Effect.Effect<void, DesktopTelemetryControlFailed>;
}

export class DesktopTelemetryReceiver extends Context.Service<
  DesktopTelemetryReceiver,
  DesktopTelemetryReceiverShape
>()("t3/resourceTelemetry/DesktopTelemetryReceiver") {}

const decodeMessage = Schema.decodeUnknownEffect(DesktopHostTelemetryMessage);
const encodeControlMessage = Schema.encodeEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);
const isDescriptorUnavailable = Schema.is(DesktopTelemetryDescriptorUnavailable);
const isProtocolMismatch = Schema.is(DesktopTelemetryProtocolMismatch);
const isDecodeFailed = Schema.is(DesktopTelemetryDecodeFailed);
const isStreamFailed = Schema.is(DesktopTelemetryStreamFailed);

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

export const make = Effect.fn("resourceTelemetry.desktopTelemetryReceiver.make")(function* () {
  const config = yield* ServerConfig;
  const latest = yield* Ref.make(Option.none<DesktopHostTelemetrySnapshot>());
  const changes = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(8);
  const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
  const controlMutex = yield* Semaphore.make(1);
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
    Ref.modify(health, (current) => {
      const next: DesktopTelemetryReceiverHealth = {
        status: "healthy",
        lastSampleAt: Option.some(sampledAt),
        lastError: Option.none(),
      };
      return [
        current.status !== "healthy" || Option.isSome(current.lastError)
          ? Option.some(next)
          : Option.none(),
        next,
      ] as const;
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (next) => PubSub.publish(healthChanges, next),
        }),
      ),
      Effect.asVoid,
    );

  const setDiagnosticsDemand: DesktopTelemetryReceiverShape["setDiagnosticsDemand"] = (enabled) =>
    controlMutex.withPermits(1)(
      Effect.gen(function* () {
        const fd = config.desktopTelemetryControlFd;
        if (fd === undefined) return;
        const encoded = yield* encodeControlMessage({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTelemetryControlFailed({
                fd,
                operation: "encode",
                cause,
              }),
          ),
        );
        yield* Effect.try({
          try: () => {
            const payload = Buffer.from(`${encoded}\n`);
            let offset = 0;
            while (offset < payload.byteLength) {
              const written = NodeFS.writeSync(fd, payload, offset);
              if (written <= 0) throw new Error("desktop telemetry control pipe accepted no bytes");
              offset += written;
            }
          },
          catch: (cause) =>
            new DesktopTelemetryControlFailed({
              fd,
              operation: "write",
              cause,
            }),
        }).pipe(
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
        if (message.type === "desktopTelemetryHello") {
          return updateHealth(
            (current): DesktopTelemetryReceiverHealth => ({
              ...current,
              status: "healthy",
              lastError: Option.none(),
            }),
          );
        }

        const sampledAt = DateTime.makeUnsafe(message.sampledAtUnixMs);
        return Ref.set(latest, Option.some(message)).pipe(
          Effect.andThen(updateSampleHealth(sampledAt)),
          Effect.andThen(PubSub.publish(changes, message)),
          Effect.asVoid,
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
          Effect.gen(function* () {
            const current = yield* Ref.get(latest);
            if (Option.isNone(current) || current.value.power.stale) return;
            const now = yield* DateTime.now;
            if (DateTime.toEpochMillis(now) - current.value.sampledAtUnixMs < STALE_AFTER_MS)
              return;
            const staleSnapshot: DesktopHostTelemetrySnapshot = {
              ...current.value,
              power: { ...current.value.power, stale: true },
            };
            yield* Ref.set(latest, Option.some(staleSnapshot));
            yield* updateHealth((currentHealth) => ({
              ...currentHealth,
              status: currentHealth.status === "stopped" ? "stopped" : "degraded",
              lastError:
                currentHealth.status === "stopped"
                  ? currentHealth.lastError
                  : Option.some(
                      new DesktopTelemetryStale({ fd, staleAfterMs: STALE_AFTER_MS }).message,
                    ),
            }));
            yield* PubSub.publish(changes, staleSnapshot);
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }

  return DesktopTelemetryReceiver.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    health: Ref.get(health),
    healthChanges: Stream.fromPubSub(healthChanges),
    setDiagnosticsDemand,
  });
});

export const layer = Layer.effect(DesktopTelemetryReceiver, make());

export const layerTest = (
  overrides: Partial<DesktopTelemetryReceiverShape> = {},
): Layer.Layer<DesktopTelemetryReceiver> =>
  Layer.succeed(
    DesktopTelemetryReceiver,
    DesktopTelemetryReceiver.of({
      latest: Effect.succeedNone,
      changes: Stream.empty,
      health: Effect.succeed({
        status: "unavailable",
        lastSampleAt: Option.none(),
        lastError: Option.some("Desktop telemetry test implementation is unavailable."),
      }),
      healthChanges: Stream.empty,
      setDiagnosticsDemand: () => Effect.void,
      ...overrides,
    }),
  );
