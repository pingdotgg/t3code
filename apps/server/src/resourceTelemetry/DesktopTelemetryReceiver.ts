// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFileSystem from "node:fs";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetryMessage as DesktopHostTelemetryMessageValue,
  type DesktopHostTelemetrySnapshot,
  type ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";

import { ServerConfig } from "../config.ts";

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

export type DesktopTelemetryReceiverError =
  | DesktopTelemetryDescriptorUnavailable
  | DesktopTelemetryProtocolMismatch
  | DesktopTelemetryDecodeFailed
  | DesktopTelemetryStreamFailed
  | DesktopTelemetryStreamClosed;

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
}

export class DesktopTelemetryReceiver extends Context.Service<
  DesktopTelemetryReceiver,
  DesktopTelemetryReceiverShape
>()("t3/resourceTelemetry/DesktopTelemetryReceiver") {}

const decodeMessage = Schema.decodeUnknownEffect(DesktopHostTelemetryMessage);
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

  if (config.desktopTelemetryFd !== undefined) {
    const fd = config.desktopTelemetryFd;
    const readable = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          NodeFileSystem.createReadStream("", {
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
          Effect.andThen(
            Ref.set(health, {
              status: "healthy",
              lastSampleAt: Option.some(sampledAt),
              lastError: Option.none(),
            }),
          ),
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
  }

  return DesktopTelemetryReceiver.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    health: Ref.get(health),
    healthChanges: Stream.fromPubSub(healthChanges),
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
      ...overrides,
    }),
  );
