import type {
  HostPowerSnapshot,
  ResourceMonitorCapabilities,
  ResourceMonitorCommand,
  ResourceMonitorEvent,
  ResourceMonitorExternalProcess,
  ResourceMonitorHelloEvent,
  ResourceMonitorProcessTableEntry,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import * as ServerConfig from "../config.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";
import { make } from "./NativeTelemetryClientParts.ts";

const SAMPLE_INTERVAL_MS = 1_000;
// The sidecar treats 0 as "sample only on request".
export const IDLE_SAMPLE_INTERVAL_MS = 0;
const BATTERY_SAMPLE_INTERVAL_MS = 5_000;
const CONSTRAINED_SAMPLE_INTERVAL_MS = 15_000;
export const HANDSHAKE_TIMEOUT = Duration.seconds(5);
export const SAMPLE_REQUEST_TIMEOUT = Duration.seconds(5);
export const PROCESS_TABLE_REQUEST_TIMEOUT = Duration.seconds(5);
export const HISTORY_REQUEST_TIMEOUT = Duration.seconds(15);
const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const FAILURE_WINDOW_MS = 60_000;
export const MAX_FAILURES_PER_WINDOW = 5;

export class NativeTelemetrySpawnFailed extends Schema.TaggedError<NativeTelemetrySpawnFailed>()(
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

export class NativeTelemetryHandshakeTimedOut extends Schema.TaggedError<NativeTelemetryHandshakeTimedOut>()(
  "NativeTelemetryHandshakeTimedOut",
  {
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor handshake timed out after ${this.timeoutMs}ms.`;
  }
}

export class NativeTelemetryRequestTimedOut extends Schema.TaggedError<NativeTelemetryRequestTimedOut>()(
  "NativeTelemetryRequestTimedOut",
  {
    operation: Schema.Literals(["processTable", "readHistory", "sampleNow"]),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor '${this.operation}' request timed out after ${this.timeoutMs}ms.`;
  }
}

export class NativeTelemetryProtocolMismatch extends Schema.TaggedError<NativeTelemetryProtocolMismatch>()(
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

export class NativeTelemetryDecodeFailed extends Schema.TaggedError<NativeTelemetryDecodeFailed>()(
  "NativeTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode resource monitor output.";
  }
}

export class NativeTelemetryCommandFailed extends Schema.TaggedError<NativeTelemetryCommandFailed>()(
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

export class NativeTelemetryExited extends Schema.TaggedError<NativeTelemetryExited>()(
  "NativeTelemetryExited",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor exited with code ${this.exitCode}.`;
  }
}

export class NativeTelemetryStreamClosed extends Schema.TaggedError<NativeTelemetryStreamClosed>()(
  "NativeTelemetryStreamClosed",
  {},
) {
  override get message(): string {
    return "Resource monitor event stream closed unexpectedly.";
  }
}

export class NativeTelemetryUnavailable extends Schema.TaggedError<NativeTelemetryUnavailable>()(
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
  | ResourceMonitorBinary.ResourceMonitorBinaryError
  | NativeTelemetrySpawnFailed
  | NativeTelemetryHandshakeTimedOut
  | NativeTelemetryRequestTimedOut
  | NativeTelemetryProtocolMismatch
  | NativeTelemetryDecodeFailed
  | NativeTelemetryCommandFailed
  | NativeTelemetryExited
  | NativeTelemetryStreamClosed
  | NativeTelemetryUnavailable;

export interface NativeTelemetryClientHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
  readonly sampleIntervalMs: number;
}

export interface NativeTelemetrySnapshot {
  readonly generation: number;
  readonly snapshot: ResourceMonitorSnapshotEvent;
}

export class NativeTelemetryClient extends Context.Service<
  NativeTelemetryClient,
  {
    readonly capabilities: Effect.Effect<ResourceMonitorCapabilities, NativeTelemetryClientError>;
    readonly snapshots: Stream.Stream<NativeTelemetrySnapshot, NativeTelemetryClientError>;
    readonly readHistory: (
      windowMs: number,
    ) => Effect.Effect<ReadonlyArray<ResourceMonitorSnapshotEvent>, NativeTelemetryClientError>;
    readonly setExternalProcesses: (
      processes: ReadonlyArray<ResourceMonitorExternalProcess>,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly setHostPowerState: (
      snapshot: HostPowerSnapshot,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly sampleNow: Effect.Effect<NativeTelemetrySnapshot, NativeTelemetryClientError>;
    readonly processTable: Effect.Effect<
      ReadonlyArray<ResourceMonitorProcessTableEntry>,
      NativeTelemetryClientError
    >;
    readonly retry: Effect.Effect<boolean>;
    readonly health: Effect.Effect<NativeTelemetryClientHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: NativeTelemetryClientHealth;
        readonly changes: Stream.Stream<NativeTelemetryClientHealth>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/resourceTelemetry/NativeTelemetryClient") {}

interface ClientState {
  readonly status: ResourceTelemetrySourceStatus;
  readonly handle: Option.Option<ChildProcessSpawner.ChildProcessHandle>;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
}

export interface CollectionControl {
  readonly hostPower: HostPowerSnapshot;
  readonly liveSubscriberCount: number;
  readonly sampleIntervalMs: number;
}

export interface PendingHistoryRequest {
  readonly deferred: Deferred.Deferred<
    ReadonlyArray<ResourceMonitorSnapshotEvent>,
    NativeTelemetryClientError
  >;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
}

export const initialState: ClientState = {
  status: "starting",
  handle: Option.none(),
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.none(),
  restartCount: 0,
};

export function toHealth(state: ClientState, sampleIntervalMs: number): NativeTelemetryClientHealth {
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

// Without a live subscriber the sidecar does not sample on a timer, so an idle server
// never walks the process table. History then covers only time with a subscriber.
export function resolveNativeSampleIntervalMs(
  snapshot: HostPowerSnapshot,
  liveSubscriberCount: number,
): number {
  if (liveSubscriberCount === 0) return IDLE_SAMPLE_INTERVAL_MS;
  if (snapshot.stale || snapshot.source === "unknown") return SAMPLE_INTERVAL_MS;
  if (
    snapshot.suspended ||
    snapshot.locked === "true" ||
    snapshot.lowPowerMode === "true" ||
    isThermallyConstrained(snapshot)
  ) {
    return CONSTRAINED_SAMPLE_INTERVAL_MS;
  }
  if (snapshot.onBattery === "true") return BATTERY_SAMPLE_INTERVAL_MS;
  return SAMPLE_INTERVAL_MS;
}

// Desktop power samples also commit control state; avoid a span for each sample.
export const commitCollectionControlUpdate = Effect.fnUntraced(function* <E, R>(
  desiredState: Ref.Ref<CollectionControl>,
  appliedState: Ref.Ref<CollectionControl>,
  update: (current: CollectionControl) => CollectionControl,
  apply: (previous: CollectionControl, next: CollectionControl) => Effect.Effect<void, E, R>,
): Effect.fn.Return<readonly [CollectionControl, CollectionControl], E, R> {
  const [previousDesired, next] = yield* Ref.modify(desiredState, (previous) => {
    const next = update(previous);
    return [[previous, next] as const, next];
  });
  const previousApplied = yield* Ref.get(appliedState);
  yield* apply(previousApplied, next);
  yield* Ref.set(appliedState, next);
  return [previousDesired, next] as const;
});

export function synchronizeCollectionControlOnStart<E1, R1, E2, R2>(
  mutex: Semaphore.Semaphore,
  desiredState: Ref.Ref<CollectionControl>,
  appliedState: Ref.Ref<CollectionControl>,
  apply: (control: CollectionControl) => Effect.Effect<void, E1, R1>,
  markReady: Effect.Effect<void, E2, R2>,
) {
  return mutex.withPermits(1)(
    Effect.gen(function* () {
      const control = yield* Ref.get(desiredState);
      yield* apply(control);
      yield* Ref.set(appliedState, control);
      yield* markReady;
      return control;
    }),
  );
}

export const decodeMonitorEvent: (
  value: unknown,
) => Effect.Effect<ResourceMonitorEvent, Schema.SchemaError> = Schema.decodeUnknownEffect(
  ResourceMonitorEventSchema,
);
export const encodeMonitorCommand = Schema.encodeEffect(
  Schema.fromJsonString(ResourceMonitorCommandSchema),
);
export const isProtocolMismatch = Schema.is(NativeTelemetryProtocolMismatch);
export const isDecodeFailed = Schema.is(NativeTelemetryDecodeFailed);
export const isCommandFailed = Schema.is(NativeTelemetryCommandFailed);

export function eventVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}

export function restartDelay(attempt: number): Duration.Duration {
  return Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);
}

export function retainRecentNativeTelemetryFailures(
  failures: ReadonlyArray<number>,
  now: number,
): ReadonlyArray<number> {
  return failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS);
}

export function errorMessage(error: NativeTelemetryClientError): string {
  return error.message;
}

export function canRequestNativeTelemetryRetry(
  status: ResourceTelemetrySourceStatus,
  hasHandle: boolean,
): boolean {
  return status !== "healthy" && status !== "starting" && !hasHandle;
}

export function canCommandNativeTelemetrySidecar(
  status: ResourceTelemetrySourceStatus,
  hasHandle: boolean,
): boolean {
  return hasHandle && (status === "healthy" || status === "degraded");
}

/** @public */
export const layer = Layer.effect(NativeTelemetryClient, make());

export const layerTest = (
  overrides: Partial<NativeTelemetryClient["Service"]> = {},
): Layer.Layer<NativeTelemetryClient> => {
  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      hello: Option.none<ResourceMonitorHelloEvent>(),
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Resource monitor test implementation is unavailable."),
      restartCount: 0,
      sampleIntervalMs: IDLE_SAMPLE_INTERVAL_MS,
    });
  return Layer.succeed(
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
      readHistory: Effect.fn("NativeTelemetryClient.readHistory")(function () {
        return Effect.fail(
          new NativeTelemetryUnavailable({
            reason: "No resource monitor history was configured for this test.",
          }),
        );
      }),
      setExternalProcesses: Effect.fn("NativeTelemetryClient.setExternalProcesses")(function () {
        return Effect.void;
      }),
      setHostPowerState: Effect.fn("NativeTelemetryClient.setHostPowerState")(function () {
        return Effect.void;
      }),
      sampleNow: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor sample was configured for this test.",
        }),
      ),
      processTable: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor process table was configured for this test.",
        }),
      ),
      retry: Effect.succeed(false),
      health,
      subscribeHealth:
        overrides.subscribeHealth ??
        health.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes: Stream.empty,
          })),
        ),
      ...overrides,
    }),
  );
};
export * from "./NativeTelemetryClientParts.ts";
