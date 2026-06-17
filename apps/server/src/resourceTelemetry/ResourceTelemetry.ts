import type {
  DesktopHostTelemetrySnapshot,
  HostPowerSnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryProcessIdentity,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "./DesktopTelemetryReceiver.ts";
import {
  emptyTelemetryCounters,
  mergeProcesses,
  type ProcessState,
  type TelemetryCounters,
} from "./Model.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceAttribution from "./ResourceAttribution.ts";
import * as ResourceTelemetryStore from "./ResourceTelemetryStore.ts";

const SAMPLE_INTERVAL_MS = 1_000;

export class ResourceTelemetryRefreshFailed extends Schema.TaggedErrorClass<ResourceTelemetryRefreshFailed>()(
  "ResourceTelemetryRefreshFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Resource telemetry operation '${this.operation}' failed.`;
  }
}

export interface ResourceTelemetryShape {
  readonly latest: Effect.Effect<ResourceTelemetrySnapshot>;
  readonly changes: Stream.Stream<ResourceTelemetrySnapshot>;
  readonly readHistory: (
    input: ResourceTelemetryHistoryInput,
  ) => Effect.Effect<ResourceTelemetryHistory>;
  readonly refresh: Effect.Effect<ResourceTelemetrySnapshot, ResourceTelemetryRefreshFailed>;
  readonly validateProcessIdentity: (
    identity: ResourceTelemetryProcessIdentity,
  ) => Effect.Effect<boolean, ResourceTelemetryRefreshFailed>;
  readonly retry: Effect.Effect<ResourceTelemetryRetryResult>;
}

export class ResourceTelemetry extends Context.Service<ResourceTelemetry, ResourceTelemetryShape>()(
  "t3/resourceTelemetry/ResourceTelemetry",
) {}

interface TelemetryState {
  readonly nativeSnapshot: Option.Option<ResourceMonitorSnapshotEvent>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly previous: ReadonlyMap<string, ProcessState>;
  readonly counters: TelemetryCounters;
  readonly latest: ResourceTelemetrySnapshot;
  readonly lastNativeSequence: number;
  readonly lastNativeRestartCount: number;
}

function unknownPower(updatedAt: DateTime.Utc): HostPowerSnapshot {
  return {
    source: "unknown",
    idle: "unknown",
    idleSeconds: null,
    locked: "unknown",
    suspended: false,
    onBattery: "unknown",
    lowPowerMode: "unknown",
    thermalState: "unknown",
    stale: true,
    updatedAt,
  };
}

function buildHealth(input: {
  readonly native: NativeTelemetryClient.NativeTelemetryClientHealth;
  readonly desktop: DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth;
  readonly nativeSnapshot: Option.Option<ResourceMonitorSnapshotEvent>;
}): ResourceTelemetryHealth {
  return {
    native: {
      status: input.native.status,
      lastSampleAt: input.native.lastSampleAt,
      lastError: input.native.lastError,
    },
    desktop: {
      status: input.desktop.status,
      lastSampleAt: input.desktop.lastSampleAt,
      lastError: input.desktop.lastError,
    },
    sidecarVersion: Option.map(input.native.hello, (hello) => hello.sidecarVersion),
    sidecarPid: Option.map(input.native.hello, (hello) => hello.sidecarPid),
    restartCount: input.native.restartCount,
    collectionDurationMicros: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.collectionDurationMicros,
    }),
    scannedProcessCount: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.scannedProcessCount,
    }),
    retainedProcessCount: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.retainedProcessCount,
    }),
    inaccessibleProcessCount: Option.match(input.nativeSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.inaccessibleProcessCount,
    }),
  };
}

export const make = Effect.fn("resourceTelemetry.resourceTelemetry.make")(function* () {
  const nativeClient = yield* NativeTelemetryClient.NativeTelemetryClient;
  const desktopReceiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const attribution = yield* ResourceAttribution.ResourceAttribution;
  const mutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<ResourceTelemetrySnapshot>(8);
  const initialReadAt = yield* DateTime.now;
  const initialDesktop = yield* desktopReceiver.latest;
  if (Option.isSome(initialDesktop)) {
    yield* nativeClient
      .setExternalProcesses(
        initialDesktop.value.electronProcesses.map((process) => ({
          pid: process.pid,
          startTimeMs: process.creationTimeMs,
        })),
      )
      .pipe(Effect.ignore);
  }
  const [initialNativeHealth, initialDesktopHealth, initialAttribution] = yield* Effect.all([
    nativeClient.health,
    desktopReceiver.health,
    attribution.snapshot,
  ]);
  const initialMerge = mergeProcesses({
    serverPid: process.pid,
    sidecarPid: Option.map(initialNativeHealth.hello, (hello) => hello.sidecarPid),
    fallbackSampledAtMs: DateTime.toEpochMillis(initialReadAt),
    nativeSnapshot: Option.none(),
    desktopSnapshot: initialDesktop,
    previous: new Map(),
    counters: emptyTelemetryCounters(),
    updatePrevious: false,
  });
  const initialSnapshot: ResourceTelemetrySnapshot = {
    readAt: initialReadAt,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    processes: initialMerge.processes,
    groups: initialMerge.groups,
    power: Option.match(initialDesktop, {
      onNone: () => unknownPower(initialReadAt),
      onSome: (desktop) => desktop.power,
    }),
    speedLimitPercent: Option.flatMap(initialDesktop, (desktop) => desktop.speedLimitPercent),
    attribution: initialAttribution,
    health: buildHealth({
      native: initialNativeHealth,
      desktop: initialDesktopHealth,
      nativeSnapshot: Option.none(),
    }),
  };
  const state = yield* Ref.make<TelemetryState>({
    nativeSnapshot: Option.none(),
    desktopSnapshot: initialDesktop,
    previous: new Map(),
    counters: emptyTelemetryCounters(),
    latest: initialSnapshot,
    lastNativeSequence: 0,
    lastNativeRestartCount: initialNativeHealth.restartCount,
  });
  const store = yield* ResourceTelemetryStore.make(initialSnapshot);
  const refreshHealth = mutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const [nativeHealth, desktopHealth] = yield* Effect.all([
        nativeClient.health,
        desktopReceiver.health,
      ]);
      const snapshot: ResourceTelemetrySnapshot = {
        ...current.latest,
        health: buildHealth({
          native: nativeHealth,
          desktop: desktopHealth,
          nativeSnapshot: current.nativeSnapshot,
        }),
      };
      yield* Ref.set(state, {
        ...current,
        latest: snapshot,
      });
      yield* store.updateLatest(snapshot);
      yield* PubSub.publish(changes, snapshot);
    }),
  );

  const rebuild = (input: {
    readonly nativeSnapshot?: ResourceMonitorSnapshotEvent;
    readonly desktopSnapshot?: DesktopHostTelemetrySnapshot;
    readonly updatePrevious: boolean;
  }): Effect.Effect<ResourceTelemetrySnapshot> =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const nativeHealth = yield* nativeClient.health;
        const nativeGenerationChanged =
          nativeHealth.restartCount !== current.lastNativeRestartCount;
        if (
          input.nativeSnapshot &&
          !nativeGenerationChanged &&
          input.nativeSnapshot.sequence <= current.lastNativeSequence
        ) {
          return current.latest;
        }
        const nativeSnapshot = input.nativeSnapshot
          ? Option.some(input.nativeSnapshot)
          : current.nativeSnapshot;
        const desktopSnapshot = input.desktopSnapshot
          ? Option.some(input.desktopSnapshot)
          : current.desktopSnapshot;
        const [desktopHealth, attributionSnapshot] = yield* Effect.all([
          desktopReceiver.health,
          attribution.snapshot,
        ]);
        const merged = mergeProcesses({
          serverPid: process.pid,
          sidecarPid: Option.map(nativeHealth.hello, (hello) => hello.sidecarPid),
          fallbackSampledAtMs: DateTime.toEpochMillis(current.latest.readAt),
          nativeSnapshot,
          desktopSnapshot,
          previous: current.previous,
          counters: current.counters,
          updatePrevious: input.updatePrevious,
        });
        const readAt = DateTime.makeUnsafe(merged.sampledAtMs);
        const snapshot: ResourceTelemetrySnapshot = {
          readAt,
          sampleIntervalMs: SAMPLE_INTERVAL_MS,
          processes: merged.processes,
          groups: merged.groups,
          power: Option.match(desktopSnapshot, {
            onNone: () => unknownPower(readAt),
            onSome: (desktop) => desktop.power,
          }),
          speedLimitPercent: Option.match(desktopSnapshot, {
            onNone: () => Option.none(),
            onSome: (desktop) => desktop.speedLimitPercent,
          }),
          attribution: attributionSnapshot,
          health: buildHealth({
            native: nativeHealth,
            desktop: desktopHealth,
            nativeSnapshot,
          }),
        };
        yield* Ref.set(state, {
          nativeSnapshot,
          desktopSnapshot,
          previous: merged.previous,
          counters: merged.counters,
          latest: snapshot,
          lastNativeSequence: input.nativeSnapshot?.sequence ?? current.lastNativeSequence,
          lastNativeRestartCount: input.nativeSnapshot
            ? nativeHealth.restartCount
            : current.lastNativeRestartCount,
        });
        if (input.updatePrevious) {
          yield* store.record(snapshot, merged.deltas);
        }
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      }),
    );

  const ingestNative = (snapshot: ResourceMonitorSnapshotEvent) =>
    rebuild({ nativeSnapshot: snapshot, updatePrevious: true });
  const ingestDesktop = (snapshot: DesktopHostTelemetrySnapshot) =>
    Effect.gen(function* () {
      yield* nativeClient
        .setExternalProcesses(
          snapshot.electronProcesses.map((process) => ({
            pid: process.pid,
            startTimeMs: process.creationTimeMs,
          })),
        )
        .pipe(Effect.ignore);
      return yield* rebuild({ desktopSnapshot: snapshot, updatePrevious: false });
    });

  yield* nativeClient.snapshots.pipe(
    Stream.runForEach((snapshot) => ingestNative(snapshot)),
    Effect.catch((error) =>
      Effect.logWarning("Native resource telemetry stream stopped", {
        cause: error.message,
      }),
    ),
    Effect.forkScoped,
  );
  yield* desktopReceiver.changes.pipe(
    Stream.runForEach((snapshot) => ingestDesktop(snapshot)),
    Effect.forkScoped,
  );
  yield* nativeClient.healthChanges.pipe(
    Stream.runForEach(() => refreshHealth),
    Effect.forkScoped,
  );
  yield* desktopReceiver.healthChanges.pipe(
    Stream.runForEach(() => refreshHealth),
    Effect.forkScoped,
  );

  const refresh: ResourceTelemetryShape["refresh"] = nativeClient.sampleNow.pipe(
    Effect.flatMap(ingestNative),
    Effect.mapError(
      (cause) =>
        new ResourceTelemetryRefreshFailed({
          operation: "refresh",
          cause,
        }),
    ),
  );

  const validateProcessIdentity: ResourceTelemetryShape["validateProcessIdentity"] = (identity) =>
    nativeClient.sampleNow.pipe(
      Effect.map((snapshot) =>
        snapshot.processes.some(
          (process) => process.pid === identity.pid && process.startTimeMs === identity.startTimeMs,
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ResourceTelemetryRefreshFailed({
            operation: "validateProcessIdentity",
            cause,
          }),
      ),
    );

  return ResourceTelemetry.of({
    latest: Ref.get(state).pipe(Effect.map((current) => current.latest)),
    changes: Stream.fromPubSub(changes),
    readHistory: store.readHistory,
    refresh,
    validateProcessIdentity,
    retry: nativeClient.retry.pipe(
      Effect.zip(Ref.get(state)),
      Effect.map(
        ([accepted, current]): ResourceTelemetryRetryResult => ({
          accepted,
          snapshot: current.latest,
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(ResourceTelemetry, make());
