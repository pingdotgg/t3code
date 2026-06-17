import type {
  HostPowerSnapshot,
  ResourceMonitorCapabilities,
  ResourceMonitorCommand,
  ResourceMonitorEvent,
  ResourceMonitorExternalProcess,
  ResourceMonitorHelloEvent,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import {
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorCommand as ResourceMonitorCommandSchema,
  ResourceMonitorEvent as ResourceMonitorEventSchema,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import { ServerConfig } from "../config.ts";

const SAMPLE_INTERVAL_MS = 1_000;
const UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS = 5_000;
const BATTERY_SAMPLE_INTERVAL_MS = 5_000;
const CONSTRAINED_SAMPLE_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT = Duration.seconds(5);
const SAMPLE_REQUEST_TIMEOUT = Duration.seconds(5);
const HISTORY_REQUEST_TIMEOUT = Duration.seconds(15);
const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;

export class NativeTelemetrySpawnFailed extends Schema.TaggedErrorClass<NativeTelemetrySpawnFailed>()(
  "NativeTelemetrySpawnFailed",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to start resource monitor '${this.path}'.`;
  }
}

export class NativeTelemetryHandshakeTimedOut extends Schema.TaggedErrorClass<NativeTelemetryHandshakeTimedOut>()(
  "NativeTelemetryHandshakeTimedOut",
  {
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor handshake timed out after ${this.timeoutMs}ms.`;
  }
}

export class NativeTelemetryProtocolMismatch extends Schema.TaggedErrorClass<NativeTelemetryProtocolMismatch>()(
  "NativeTelemetryProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class NativeTelemetryDecodeFailed extends Schema.TaggedErrorClass<NativeTelemetryDecodeFailed>()(
  "NativeTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode resource monitor output.";
  }
}

export class NativeTelemetryCommandFailed extends Schema.TaggedErrorClass<NativeTelemetryCommandFailed>()(
  "NativeTelemetryCommandFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Resource monitor command '${this.operation}' failed.`;
  }
}

export class NativeTelemetryExited extends Schema.TaggedErrorClass<NativeTelemetryExited>()(
  "NativeTelemetryExited",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor exited with code ${this.exitCode}.`;
  }
}

export class NativeTelemetryUnavailable extends Schema.TaggedErrorClass<NativeTelemetryUnavailable>()(
  "NativeTelemetryUnavailable",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Resource monitor is unavailable: ${this.reason}`;
  }
}

export type NativeTelemetryClientError =
  | NativeTelemetrySpawnFailed
  | NativeTelemetryHandshakeTimedOut
  | NativeTelemetryProtocolMismatch
  | NativeTelemetryDecodeFailed
  | NativeTelemetryCommandFailed
  | NativeTelemetryExited
  | NativeTelemetryUnavailable;

export interface NativeTelemetryClientHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
  readonly sampleIntervalMs: number;
}

export interface NativeTelemetryClientShape {
  readonly capabilities: Effect.Effect<ResourceMonitorCapabilities, NativeTelemetryClientError>;
  readonly snapshots: Stream.Stream<ResourceMonitorSnapshotEvent, NativeTelemetryClientError>;
  readonly readHistory: (
    windowMs: number,
  ) => Effect.Effect<ReadonlyArray<ResourceMonitorSnapshotEvent>, NativeTelemetryClientError>;
  readonly setExternalProcesses: (
    processes: ReadonlyArray<ResourceMonitorExternalProcess>,
  ) => Effect.Effect<void, NativeTelemetryClientError>;
  readonly setHostPowerState: (
    snapshot: HostPowerSnapshot,
  ) => Effect.Effect<void, NativeTelemetryClientError>;
  readonly sampleNow: Effect.Effect<ResourceMonitorSnapshotEvent, NativeTelemetryClientError>;
  readonly retry: Effect.Effect<boolean>;
  readonly health: Effect.Effect<NativeTelemetryClientHealth>;
  readonly healthChanges: Stream.Stream<NativeTelemetryClientHealth>;
}

export class NativeTelemetryClient extends Context.Service<
  NativeTelemetryClient,
  NativeTelemetryClientShape
>()("t3/resourceTelemetry/NativeTelemetryClient") {}

interface ClientState {
  readonly status: ResourceTelemetrySourceStatus;
  readonly handle: Option.Option<ChildProcessSpawner.ChildProcessHandle>;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
}

interface CollectionControl {
  readonly hostPower: HostPowerSnapshot;
  readonly liveSubscriberCount: number;
  readonly sampleIntervalMs: number;
}

interface PendingHistoryRequest {
  readonly deferred: Deferred.Deferred<
    ReadonlyArray<ResourceMonitorSnapshotEvent>,
    NativeTelemetryClientError
  >;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
}

const initialState: ClientState = {
  status: "starting",
  handle: Option.none(),
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.none(),
  restartCount: 0,
};

function toHealth(state: ClientState, sampleIntervalMs: number): NativeTelemetryClientHealth {
  return {
    status: state.status,
    hello: state.hello,
    lastSampleAt: state.lastSampleAt,
    lastError: state.lastError,
    restartCount: state.restartCount,
    sampleIntervalMs,
  };
}

function isThermallyConstrained(snapshot: HostPowerSnapshot): boolean {
  return snapshot.thermalState === "serious" || snapshot.thermalState === "critical";
}

export function resolveNativeSampleIntervalMs(
  snapshot: HostPowerSnapshot,
  liveSubscriberCount: number,
): number {
  if (snapshot.stale || snapshot.source === "unknown") {
    return liveSubscriberCount > 0 ? SAMPLE_INTERVAL_MS : UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS;
  }
  if (snapshot.suspended) return 0;
  if (
    snapshot.locked === "true" ||
    snapshot.lowPowerMode === "true" ||
    isThermallyConstrained(snapshot)
  ) {
    return CONSTRAINED_SAMPLE_INTERVAL_MS;
  }
  if (snapshot.onBattery === "true") return BATTERY_SAMPLE_INTERVAL_MS;
  return SAMPLE_INTERVAL_MS;
}

const decodeMonitorEvent: (
  value: unknown,
) => Effect.Effect<ResourceMonitorEvent, Schema.SchemaError> = Schema.decodeUnknownEffect(
  ResourceMonitorEventSchema,
);
const encodeMonitorCommand = Schema.encodeEffect(
  Schema.fromJsonString(ResourceMonitorCommandSchema),
);
const isProtocolMismatch = Schema.is(NativeTelemetryProtocolMismatch);
const isDecodeFailed = Schema.is(NativeTelemetryDecodeFailed);
const isCommandFailed = Schema.is(NativeTelemetryCommandFailed);

function eventVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}

function restartDelay(attempt: number): Duration.Duration {
  return Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);
}

function errorMessage(error: NativeTelemetryClientError): string {
  return error.message;
}

export const make = Effect.fn("resourceTelemetry.nativeTelemetryClient.make")(function* () {
  const binary = yield* ResourceMonitorBinary.ResourceMonitorBinary;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const initializedAt = yield* DateTime.now;
  const state = yield* Ref.make(initialState);
  const collectionControl = yield* Ref.make<CollectionControl>({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: initializedAt,
    },
    liveSubscriberCount: 0,
    sampleIntervalMs: UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS,
  });
  const externalProcesses = yield* Ref.make<ReadonlyArray<ResourceMonitorExternalProcess>>([]);
  const pendingSamples = yield* Ref.make(
    new Map<string, Deferred.Deferred<ResourceMonitorSnapshotEvent, NativeTelemetryClientError>>(),
  );
  const pendingHistories = yield* Ref.make(new Map<string, PendingHistoryRequest>());
  const snapshots = yield* PubSub.sliding<ResourceMonitorSnapshotEvent>(8);
  const healthChanges = yield* PubSub.sliding<NativeTelemetryClientHealth>(4);
  const retryQueue = yield* Queue.sliding<void>(1);
  const commandMutex = yield* Semaphore.make(1);
  const currentHealth = Effect.all([Ref.get(state), Ref.get(collectionControl)]).pipe(
    Effect.map(([current, control]) => toHealth(current, control.sampleIntervalMs)),
  );
  const publishHealth = currentHealth.pipe(
    Effect.flatMap((health) => PubSub.publish(healthChanges, health)),
    Effect.asVoid,
  );

  const failPending = (error: NativeTelemetryClientError) =>
    Effect.gen(function* () {
      const samples = yield* Ref.getAndSet(pendingSamples, new Map());
      const histories = yield* Ref.getAndSet(pendingHistories, new Map());
      yield* Effect.forEach(samples.values(), (deferred) => Deferred.fail(deferred, error), {
        discard: true,
      });
      yield* Effect.forEach(
        histories.values(),
        (request) => Deferred.fail(request.deferred, error),
        { discard: true },
      );
    });

  const writeCommand = (
    handle: ChildProcessSpawner.ChildProcessHandle,
    command: ResourceMonitorCommand,
  ): Effect.Effect<void, NativeTelemetryClientError> =>
    commandMutex.withPermits(1)(
      encodeMonitorCommand(command).pipe(
        Effect.map((encoded) => `${encoded}\n`),
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: command.type,
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          Stream.run(Stream.encodeText(Stream.make(encoded)), handle.stdin),
        ),
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: command.type,
              cause,
            }),
        ),
      ),
    );

  const processEvent = (
    event: ResourceMonitorEvent,
    helloDeferred: Deferred.Deferred<ResourceMonitorHelloEvent>,
  ): Effect.Effect<void, NativeTelemetryClientError> => {
    switch (event.type) {
      case "hello":
        return Ref.update(state, (current) => ({
          ...current,
          status: "starting" as const,
          hello: Option.some(event),
          lastError: Option.none(),
        })).pipe(
          Effect.andThen(publishHealth),
          Effect.andThen(Deferred.succeed(helloDeferred, event)),
          Effect.asVoid,
        );
      case "snapshot":
        return Effect.gen(function* () {
          const sampledAt = DateTime.makeUnsafe(event.sampledAtUnixMs);
          yield* Ref.update(state, (current) => ({
            ...current,
            status: "healthy" as const,
            lastSampleAt: Option.some(sampledAt),
            lastError: Option.none(),
          }));
          yield* PubSub.publish(snapshots, event);
          if (event.requestId) {
            const deferred = yield* Ref.modify(pendingSamples, (pending) => {
              const next = new Map(pending);
              const current = next.get(event.requestId!);
              next.delete(event.requestId!);
              return [Option.fromUndefinedOr(current), next];
            });
            if (Option.isSome(deferred)) {
              yield* Deferred.succeed(deferred.value, event);
            }
          }
        });
      case "historyChunk":
        return Effect.gen(function* () {
          const latestSnapshot = event.snapshots.at(-1);
          if (latestSnapshot) {
            yield* Ref.update(state, (current) => ({
              ...current,
              status: "healthy" as const,
              lastSampleAt: Option.some(DateTime.makeUnsafe(latestSnapshot.sampledAtUnixMs)),
              lastError: Option.none(),
            }));
          }
          const completed = yield* Ref.modify(pendingHistories, (pending) => {
            const request = pending.get(event.requestId);
            if (!request) return [Option.none(), pending] as const;
            const snapshots = [...request.snapshots, ...event.snapshots];
            const next = new Map(pending);
            if (event.done) {
              next.delete(event.requestId);
              return [Option.some({ deferred: request.deferred, snapshots }), next] as const;
            }
            next.set(event.requestId, { deferred: request.deferred, snapshots });
            return [Option.none(), next] as const;
          });
          if (Option.isSome(completed)) {
            yield* Deferred.succeed(completed.value.deferred, completed.value.snapshots);
          }
        });
      case "error":
        return Ref.update(state, (current) => ({
          ...current,
          status: "degraded" as const,
          lastError: Option.some(event.message),
        })).pipe(
          Effect.andThen(publishHealth),
          Effect.andThen(
            event.recoverable
              ? Effect.void
              : Effect.fail(
                  new NativeTelemetryCommandFailed({
                    operation: event.code,
                    cause: event.message,
                  }),
                ),
          ),
        );
    }
  };

  const runAttempt: Effect.Effect<void, NativeTelemetryClientError> = Effect.scoped(
    Effect.gen(function* () {
      const executablePath = yield* binary.resolve.pipe(
        Effect.mapError(
          (error) =>
            new NativeTelemetryUnavailable({
              reason: error.message,
            }),
        ),
      );
      const command = ChildProcess.make(executablePath, [], {
        cwd: config.cwd,
        stdin: {
          stream: "pipe",
          endOnDone: false,
        },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      });
      const handle = yield* Effect.acquireRelease(
        spawner
          .spawn(command)
          .pipe(
            Effect.mapError(
              (cause) => new NativeTelemetrySpawnFailed({ path: executablePath, cause }),
            ),
          ),
        (child) => child.kill().pipe(Effect.ignore),
      );
      yield* Ref.update(state, (current) => ({
        ...current,
        status: "starting" as const,
        handle: Option.some(handle),
        hello: Option.none(),
      }));
      yield* publishHealth;

      const helloDeferred = yield* Deferred.make<ResourceMonitorHelloEvent>();
      const eventFiber = yield* handle.stdout.pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect(
          (
            value,
          ): Effect.Effect<
            ResourceMonitorEvent,
            NativeTelemetryProtocolMismatch | NativeTelemetryDecodeFailed
          > => {
            const version = eventVersion(value);
            if (version !== undefined && version !== RESOURCE_MONITOR_PROTOCOL_VERSION) {
              return Effect.fail(
                new NativeTelemetryProtocolMismatch({
                  expectedVersion: RESOURCE_MONITOR_PROTOCOL_VERSION,
                  receivedVersion: version,
                }),
              );
            }
            return decodeMonitorEvent(value).pipe(
              Effect.mapError((cause) => new NativeTelemetryDecodeFailed({ cause })),
            );
          },
        ),
        Stream.runForEach((event) => processEvent(event, helloDeferred)),
        Effect.mapError((cause) =>
          isProtocolMismatch(cause) || isDecodeFailed(cause) || isCommandFailed(cause)
            ? cause
            : new NativeTelemetryDecodeFailed({ cause }),
        ),
        Effect.forkScoped,
      );
      yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

      const hello = yield* Deferred.await(helloDeferred).pipe(
        Effect.timeoutOption(HANDSHAKE_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new NativeTelemetryHandshakeTimedOut({
                  timeoutMs: Duration.toMillis(HANDSHAKE_TIMEOUT),
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const control = yield* Ref.get(collectionControl);
      yield* writeCommand(handle, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "configure",
        rootPid: process.pid,
        sampleIntervalMs: control.sampleIntervalMs,
        externalProcesses: [...(yield* Ref.get(externalProcesses))],
      });
      if (control.liveSubscriberCount > 0) {
        yield* writeCommand(handle, {
          version: RESOURCE_MONITOR_PROTOCOL_VERSION,
          type: "setStreaming",
          enabled: true,
        });
      }
      yield* Ref.update(state, (current) => ({
        ...current,
        status: "healthy" as const,
        hello: Option.some(hello),
      }));
      yield* publishHealth;

      yield* writeCommand(handle, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "setExternalProcesses",
        processes: [...(yield* Ref.get(externalProcesses))],
      });
      const latestControl = yield* Ref.get(collectionControl);
      if (latestControl.sampleIntervalMs !== control.sampleIntervalMs) {
        yield* writeCommand(handle, {
          version: RESOURCE_MONITOR_PROTOCOL_VERSION,
          type: "setSampleInterval",
          sampleIntervalMs: latestControl.sampleIntervalMs,
        });
      }
      if (latestControl.liveSubscriberCount > 0 !== control.liveSubscriberCount > 0) {
        yield* writeCommand(handle, {
          version: RESOURCE_MONITOR_PROTOCOL_VERSION,
          type: "setStreaming",
          enabled: latestControl.liveSubscriberCount > 0,
        });
      }

      const exitEffect = handle.exitCode.pipe(
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: "waitForExit",
              cause,
            }),
        ),
        Effect.flatMap((exitCode) =>
          Effect.fail(new NativeTelemetryExited({ exitCode: Number(exitCode) })),
        ),
      );
      const decoderEffect = Fiber.join(eventFiber).pipe(
        Effect.andThen(Effect.fail(new NativeTelemetryExited({ exitCode: -1 }))),
      );
      return yield* Effect.raceFirst(exitEffect, decoderEffect);
    }),
  ).pipe(
    Effect.ensuring(
      Ref.update(state, (current) => ({
        ...current,
        handle: Option.none(),
      })),
    ),
  );

  yield* Effect.gen(function* () {
    let failures: ReadonlyArray<number> = [];
    let restartAttempt = 0;

    while (true) {
      const result = yield* Effect.result(runAttempt);
      if (Result.isSuccess(result)) {
        return;
      }

      const error = result.failure;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      failures = [...failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS), now];
      const exhausted = failures.length >= MAX_FAILURES_PER_WINDOW;
      yield* Ref.update(state, (current) => ({
        ...current,
        status: exhausted ? ("unavailable" as const) : ("degraded" as const),
        hello: Option.none(),
        lastError: Option.some(errorMessage(error)),
        restartCount: current.restartCount + 1,
      }));
      yield* publishHealth;
      yield* failPending(error);

      if (exhausted) {
        yield* Queue.take(retryQueue);
        failures = [];
        restartAttempt = 0;
        yield* Ref.update(state, (current) => ({
          ...current,
          status: "starting" as const,
          hello: Option.none(),
          lastError: Option.none(),
        }));
        yield* publishHealth;
        continue;
      }

      const manuallyRetried = yield* Effect.raceFirst(
        Effect.sleep(restartDelay(restartAttempt)).pipe(Effect.as(false)),
        Queue.take(retryQueue).pipe(Effect.as(true)),
      );
      restartAttempt = manuallyRetried ? 0 : restartAttempt + 1;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Ref.update(state, (current) => ({
            ...current,
            status: "unavailable" as const,
            hello: Option.none(),
            lastError: Option.some(Cause.pretty(cause)),
          })).pipe(
            Effect.andThen(publishHealth),
            Effect.andThen(
              Effect.logWarning("Resource monitor supervisor failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
    ),
    Effect.forkScoped,
  );

  const applyCollectionControl = Effect.fn(
    "resourceTelemetry.nativeTelemetryClient.applyCollectionControl",
  )(function* (previous: CollectionControl, next: CollectionControl) {
    const current = yield* Ref.get(state);
    if (Option.isSome(current.handle) && current.status === "healthy") {
      if (previous.sampleIntervalMs !== next.sampleIntervalMs) {
        yield* writeCommand(current.handle.value, {
          version: RESOURCE_MONITOR_PROTOCOL_VERSION,
          type: "setSampleInterval",
          sampleIntervalMs: next.sampleIntervalMs,
        });
      }
      const wasStreaming = previous.liveSubscriberCount > 0;
      const isStreaming = next.liveSubscriberCount > 0;
      if (wasStreaming !== isStreaming) {
        yield* writeCommand(current.handle.value, {
          version: RESOURCE_MONITOR_PROTOCOL_VERSION,
          type: "setStreaming",
          enabled: isStreaming,
        });
      }
    }
    if (previous.sampleIntervalMs !== next.sampleIntervalMs) {
      yield* publishHealth;
    }
  });

  const setHostPowerState: NativeTelemetryClientShape["setHostPowerState"] = (hostPower) =>
    Effect.gen(function* () {
      const [previous, next] = yield* Ref.modify(collectionControl, (current) => {
        const updated: CollectionControl = {
          ...current,
          hostPower,
          sampleIntervalMs: resolveNativeSampleIntervalMs(hostPower, current.liveSubscriberCount),
        };
        return [[current, updated] as const, updated];
      });
      yield* applyCollectionControl(previous, next);
    });

  const changeLiveSubscriberCount = Effect.fn(
    "resourceTelemetry.nativeTelemetryClient.changeLiveSubscriberCount",
  )(function* (delta: 1 | -1) {
    const [previous, next] = yield* Ref.modify(collectionControl, (current) => {
      const liveSubscriberCount = Math.max(0, current.liveSubscriberCount + delta);
      const updated: CollectionControl = {
        ...current,
        liveSubscriberCount,
        sampleIntervalMs: resolveNativeSampleIntervalMs(current.hostPower, liveSubscriberCount),
      };
      return [[current, updated] as const, updated];
    });
    yield* applyCollectionControl(previous, next);
  });

  const liveSnapshots = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(snapshots);
      yield* Effect.acquireRelease(changeLiveSubscriberCount(1), () =>
        changeLiveSubscriberCount(-1).pipe(Effect.ignore),
      );
      return Stream.fromSubscription(subscription);
    }),
  );

  const setExternalProcesses: NativeTelemetryClientShape["setExternalProcesses"] = (processes) =>
    Effect.gen(function* () {
      yield* Ref.set(externalProcesses, [...processes]);
      const current = yield* Ref.get(state);
      if (Option.isNone(current.handle) || current.status !== "healthy") return;
      yield* writeCommand(current.handle.value, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "setExternalProcesses",
        processes: [...processes],
      });
    });

  const readHistory: NativeTelemetryClientShape["readHistory"] = (windowMs) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (Option.isNone(current.handle) || current.status !== "healthy") {
        return yield* new NativeTelemetryUnavailable({
          reason: Option.getOrElse(current.lastError, () => "sidecar is not running"),
        });
      }
      const requestId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: "createHistoryRequestId",
              cause,
            }),
        ),
      );
      const deferred = yield* Deferred.make<
        ReadonlyArray<ResourceMonitorSnapshotEvent>,
        NativeTelemetryClientError
      >();
      yield* Ref.update(pendingHistories, (pending) => {
        const next = new Map(pending);
        next.set(requestId, { deferred, snapshots: [] });
        return next;
      });
      return yield* writeCommand(current.handle.value, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "readHistory",
        requestId,
        windowMs: Math.max(0, Math.round(windowMs)),
      }).pipe(
        Effect.andThen(
          Deferred.await(deferred).pipe(
            Effect.timeoutOption(HISTORY_REQUEST_TIMEOUT),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new NativeTelemetryCommandFailed({
                      operation: "readHistory",
                      cause: "history request timed out",
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
        Effect.ensuring(
          Ref.update(pendingHistories, (pending) => {
            const next = new Map(pending);
            next.delete(requestId);
            return next;
          }),
        ),
      );
    });

  const sampleNow: NativeTelemetryClientShape["sampleNow"] = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (Option.isNone(current.handle) || current.status !== "healthy") {
      return yield* new NativeTelemetryUnavailable({
        reason: Option.getOrElse(current.lastError, () => "sidecar is not running"),
      });
    }

    const requestId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new NativeTelemetryCommandFailed({
            operation: "createRequestId",
            cause,
          }),
      ),
    );
    const deferred = yield* Deferred.make<
      ResourceMonitorSnapshotEvent,
      NativeTelemetryClientError
    >();
    yield* Ref.update(pendingSamples, (pending) => {
      const next = new Map(pending);
      next.set(requestId, deferred);
      return next;
    });
    return yield* writeCommand(current.handle.value, {
      version: RESOURCE_MONITOR_PROTOCOL_VERSION,
      type: "sampleNow",
      requestId,
    }).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(SAMPLE_REQUEST_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NativeTelemetryCommandFailed({
                    operation: "sampleNow",
                    cause: "sample request timed out",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(pendingSamples, (pending) => {
          const next = new Map(pending);
          next.delete(requestId);
          return next;
        }),
      ),
    );
  });

  const health = currentHealth;

  return NativeTelemetryClient.of({
    capabilities: Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Option.match(current.hello, {
          onNone: () =>
            Effect.fail(
              new NativeTelemetryUnavailable({
                reason: Option.getOrElse(current.lastError, () => "handshake is incomplete"),
              }),
            ),
          onSome: (hello) => Effect.succeed(hello.capabilities),
        }),
      ),
    ),
    snapshots: liveSnapshots,
    readHistory,
    setExternalProcesses,
    setHostPowerState,
    sampleNow,
    retry: Ref.get(state).pipe(
      Effect.flatMap((current) =>
        current.status === "healthy" || current.status === "starting"
          ? Effect.succeed(false)
          : Queue.offer(retryQueue, undefined).pipe(Effect.as(true)),
      ),
    ),
    health,
    healthChanges: Stream.fromPubSub(healthChanges),
  });
});

export const layer = Layer.effect(NativeTelemetryClient, make());

export const layerTest = (
  overrides: Partial<NativeTelemetryClientShape> = {},
): Layer.Layer<NativeTelemetryClient> =>
  Layer.succeed(
    NativeTelemetryClient,
    NativeTelemetryClient.of({
      capabilities: Effect.succeed({
        cumulativeCpuTime: true,
        currentCpuPercent: true,
        residentMemory: true,
        virtualMemory: true,
        ioBytes: true,
        processStartTime: true,
        processTree: true,
      }),
      snapshots: Stream.empty,
      readHistory: () =>
        Effect.fail(
          new NativeTelemetryUnavailable({
            reason: "No resource monitor history was configured for this test.",
          }),
        ),
      setExternalProcesses: () => Effect.void,
      setHostPowerState: () => Effect.void,
      sampleNow: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor sample was configured for this test.",
        }),
      ),
      retry: Effect.succeed(false),
      health: Effect.succeed({
        status: "unavailable",
        hello: Option.none(),
        lastSampleAt: Option.none(),
        lastError: Option.some("Resource monitor test implementation is unavailable."),
        restartCount: 0,
        sampleIntervalMs: UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS,
      }),
      healthChanges: Stream.empty,
      ...overrides,
    }),
  );
