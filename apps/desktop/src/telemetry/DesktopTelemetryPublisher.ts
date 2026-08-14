import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetrySnapshot,
  type DesktopTelemetryControlMessage,
  type DesktopTelemetryRequestDesktopUpdate,
  type DesktopUpdateStatusReport,
  type HostPowerSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";

const LIVE_SAMPLE_INTERVAL = Duration.seconds(1);
const BATTERY_SAMPLE_INTERVAL = Duration.seconds(5);
const CONSTRAINED_SAMPLE_INTERVAL = Duration.seconds(15);
const DEFAULT_HOST_POWER_ACTIVE_INTERVAL = Duration.seconds(30);
const DEFAULT_HOST_POWER_IDLE_INTERVAL = Duration.minutes(2);
const IDLE_THRESHOLD_SECONDS = 60;
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(DesktopHostTelemetryMessage));
const textEncoder = new TextEncoder();

type PowerEvent =
  | { readonly type: "locked"; readonly value: boolean }
  | { readonly type: "suspended"; readonly value: boolean }
  | { readonly type: "onBattery"; readonly value: boolean }
  | { readonly type: "thermal"; readonly value: HostPowerSnapshot["thermalState"] }
  | { readonly type: "speedLimit"; readonly value: number };

interface PowerState {
  readonly idle: HostPowerSnapshot["idle"];
  readonly locked: HostPowerSnapshot["locked"];
  readonly lockedEventPending: boolean;
  readonly suspended: boolean;
  readonly suspendedEventPending: boolean;
  readonly onBattery: HostPowerSnapshot["onBattery"];
  readonly onBatteryEventPending: boolean;
  readonly thermalState: HostPowerSnapshot["thermalState"];
  readonly speedLimitPercent: Option.Option<number>;
}

interface HostPowerIntervals {
  readonly active: Duration.Duration;
  readonly idle: Duration.Duration;
}

export class DesktopTelemetryPublisher extends Context.Service<
  DesktopTelemetryPublisher,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
    readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
    readonly encoded: Stream.Stream<Uint8Array>;
    readonly handleControl: (message: DesktopTelemetryControlMessage) => Effect.Effect<void>;
    readonly handleControlForSource: (
      sourceId: string,
      message: DesktopTelemetryControlMessage,
    ) => Effect.Effect<void>;
    readonly removeControlSource: (sourceId: string) => Effect.Effect<void>;
    /** Sends the report to the attached backend and replays the latest one
        to backends that attach later (including the one spawned after a
        relaunch). */
    readonly publishUpdateReport: (report: DesktopUpdateStatusReport) => Effect.Effect<void>;
    /** Update requests received over the control channel. Single consumer. */
    readonly updateRequests: Stream.Stream<DesktopTelemetryRequestDesktopUpdate>;
  }
>()("@t3tools/desktop/telemetry/DesktopTelemetryPublisher") {}

function booleanState(value: boolean): HostPowerSnapshot["onBattery"] {
  return value ? "true" : "false";
}

function idleState(value: ElectronPowerMonitor.ElectronIdleState): HostPowerSnapshot["idle"] {
  switch (value) {
    case "active":
      return "false";
    case "idle":
    case "locked":
      return "true";
    case "unknown":
      return "unknown";
  }
}

function updatePowerState(state: PowerState, event: PowerEvent): PowerState {
  switch (event.type) {
    case "locked":
      return {
        ...state,
        locked: booleanState(event.value),
        lockedEventPending: true,
      };
    case "suspended":
      return {
        ...state,
        suspended: event.value,
        suspendedEventPending: event.value,
      };
    case "onBattery":
      return {
        ...state,
        onBattery: booleanState(event.value),
        onBatteryEventPending: true,
      };
    case "thermal":
      return { ...state, thermalState: event.value };
    case "speedLimit":
      return { ...state, speedLimitPercent: Option.some(event.value) };
  }
}

function sampleInterval(
  power: PowerState,
  diagnosticsDemand: boolean,
  hostPowerIntervals: HostPowerIntervals,
): Duration.Duration {
  if (!diagnosticsDemand) {
    return power.suspended || power.locked === "true" || power.idle === "true"
      ? hostPowerIntervals.idle
      : hostPowerIntervals.active;
  }
  if (
    power.suspended ||
    power.locked === "true" ||
    power.thermalState === "serious" ||
    power.thermalState === "critical"
  ) {
    return CONSTRAINED_SAMPLE_INTERVAL;
  }
  if (power.onBattery === "true") return BATTERY_SAMPLE_INTERVAL;
  return LIVE_SAMPLE_INTERVAL;
}

export const make = Effect.fn("desktop.telemetryPublisher.make")(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  yield* electronApp.whenReady;

  const initialPowerState: PowerState = {
    idle: "unknown",
    locked: "unknown",
    lockedEventPending: false,
    suspended: false,
    suspendedEventPending: false,
    onBattery: booleanState(yield* powerMonitor.isOnBatteryPower),
    onBatteryEventPending: false,
    thermalState: yield* powerMonitor.getCurrentThermalState,
    speedLimitPercent: Option.none(),
  };
  const powerState = yield* Ref.make(initialPowerState);
  const hostPowerIntervals = yield* Ref.make<HostPowerIntervals>({
    active: DEFAULT_HOST_POWER_ACTIVE_INTERVAL,
    idle: DEFAULT_HOST_POWER_IDLE_INTERVAL,
  });
  const powerEvents = yield* Queue.unbounded<PowerEvent>();
  const sampleTriggers = yield* Queue.sliding<void>(1);
  const diagnosticsDemandSources = yield* Ref.make<ReadonlySet<string>>(new Set());
  const latest = yield* Ref.make(Option.none<DesktopHostTelemetrySnapshot>());
  const changes = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(8);
  const sequence = yield* Ref.make(0);
  const latestUpdateReport = yield* Ref.make(Option.none<DesktopUpdateStatusReport>());
  const updateReportChanges = yield* PubSub.sliding<DesktopUpdateStatusReport>(16);
  const updateRequestQueue = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();

  const offer = (event: PowerEvent): void => {
    Queue.offerUnsafe(powerEvents, event);
  };
  yield* Effect.all(
    [
      powerMonitor.onSimpleEvent("lock-screen", () => offer({ type: "locked", value: true })),
      powerMonitor.onSimpleEvent("unlock-screen", () => offer({ type: "locked", value: false })),
      powerMonitor.onSimpleEvent("suspend", () => offer({ type: "suspended", value: true })),
      powerMonitor.onSimpleEvent("resume", () => offer({ type: "suspended", value: false })),
      powerMonitor.onSimpleEvent("on-battery", () => offer({ type: "onBattery", value: true })),
      powerMonitor.onSimpleEvent("on-ac", () => offer({ type: "onBattery", value: false })),
      powerMonitor.onThermalStateChange((value) => offer({ type: "thermal", value })),
      powerMonitor.onSpeedLimitChange((value) => offer({ type: "speedLimit", value })),
    ],
    { concurrency: "unbounded" },
  );
  yield* Effect.forever(
    Queue.take(powerEvents).pipe(
      Effect.flatMap((event) => Ref.update(powerState, (state) => updatePowerState(state, event))),
      Effect.andThen(Queue.offer(sampleTriggers, undefined)),
    ),
  ).pipe(Effect.forkScoped);

  const sampleOnce = (allowSuspendRecovery: boolean) =>
    Effect.gen(function* () {
      const sampledAt = yield* DateTime.now;
      const sampledAtUnixMs = DateTime.toEpochMillis(sampledAt);
      const demand = (yield* Ref.get(diagnosticsDemandSources)).size > 0;
      const [currentPower, idleSeconds, systemIdleState, onBattery, metrics] = yield* Effect.all(
        [
          Ref.get(powerState),
          powerMonitor.getSystemIdleTime,
          powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS),
          powerMonitor.isOnBatteryPower,
          demand ? electronApp.getAppMetrics : Effect.succeed([]),
        ],
        { concurrency: "unbounded" },
      );
      const polledLocked =
        systemIdleState === "unknown"
          ? currentPower.locked
          : booleanState(systemIdleState === "locked");
      const polledOnBattery = booleanState(onBattery);
      const observedPower = yield* Ref.modify(powerState, (latestPower) => {
        const preserveEventLocked =
          latestPower.lockedEventPending ||
          latestPower.locked !== currentPower.locked ||
          latestPower.lockedEventPending !== currentPower.lockedEventPending;
        const preserveEventOnBattery =
          latestPower.onBatteryEventPending ||
          latestPower.onBattery !== currentPower.onBattery ||
          latestPower.onBatteryEventPending !== currentPower.onBatteryEventPending;
        const preserveEventSuspended =
          latestPower.suspendedEventPending ||
          latestPower.suspended !== currentPower.suspended ||
          latestPower.suspendedEventPending !== currentPower.suspendedEventPending;
        const next: PowerState = {
          ...latestPower,
          idle: idleState(systemIdleState),
          locked: preserveEventLocked ? latestPower.locked : polledLocked,
          lockedEventPending:
            latestPower.lockedEventPending &&
            (systemIdleState === "unknown" || polledLocked !== latestPower.locked),
          suspended:
            allowSuspendRecovery && !preserveEventSuspended ? false : latestPower.suspended,
          suspendedEventPending: false,
          onBattery: preserveEventOnBattery ? latestPower.onBattery : polledOnBattery,
          onBatteryEventPending:
            latestPower.onBatteryEventPending && polledOnBattery !== latestPower.onBattery,
        };
        return [next, next] as const;
      });
      const nextSequence = yield* Ref.modify(sequence, (current) => [current + 1, current + 1]);
      const snapshot: DesktopHostTelemetrySnapshot = {
        version: 1,
        type: "desktopTelemetry",
        sequence: nextSequence,
        sampledAtUnixMs,
        electronPid: process.pid,
        power: {
          source: "electron-main",
          idle: observedPower.idle,
          idleSeconds,
          locked: observedPower.locked,
          suspended: observedPower.suspended,
          onBattery: observedPower.onBattery,
          lowPowerMode: "unknown",
          thermalState: observedPower.thermalState,
          stale: false,
          updatedAt: sampledAt,
        },
        speedLimitPercent: observedPower.speedLimitPercent,
        electronProcesses: metrics.map((metric) => ({
          pid: metric.pid,
          creationTimeMs: Math.max(0, Math.round(metric.creationTime)),
          type: metric.type,
          ...(metric.name === undefined ? {} : { name: metric.name }),
          ...(metric.serviceName === undefined ? {} : { serviceName: metric.serviceName }),
          cpuPercent: metric.cpu.percentCPUUsage,
          ...(metric.cpu.cumulativeCPUUsage === undefined
            ? {}
            : { cumulativeCpuSeconds: metric.cpu.cumulativeCPUUsage }),
          idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
          workingSetBytes: Math.max(0, Math.round(metric.memory.workingSetSize * 1024)),
          peakWorkingSetBytes: Math.max(0, Math.round(metric.memory.peakWorkingSetSize * 1024)),
        })),
      };

      yield* Ref.set(latest, Option.some(snapshot));
      yield* PubSub.publish(changes, snapshot);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Failed to sample Electron telemetry", {
              cause: String(cause),
            }),
      ),
    );

  yield* Effect.gen(function* () {
    yield* sampleOnce(false);
    while (true) {
      const [currentPower, demand, intervals] = yield* Effect.all([
        Ref.get(powerState),
        Ref.get(diagnosticsDemandSources).pipe(Effect.map((sources) => sources.size > 0)),
        Ref.get(hostPowerIntervals),
      ]);
      const allowSuspendRecovery = yield* Effect.raceFirst(
        Queue.take(sampleTriggers).pipe(Effect.as(false)),
        Effect.sleep(sampleInterval(currentPower, demand, intervals)).pipe(Effect.as(true)),
      );
      yield* sampleOnce(allowSuspendRecovery);
    }
  }).pipe(Effect.forkScoped);

  const handleControlForSource: DesktopTelemetryPublisher["Service"]["handleControlForSource"] = (
    sourceId,
    message,
  ) => {
    switch (message.type) {
      case "setDiagnosticsDemand":
        return Ref.modify(diagnosticsDemandSources, (sources) => {
          const previous = sources.size > 0;
          const next = new Set(sources);
          if (message.enabled) {
            next.add(sourceId);
          } else {
            next.delete(sourceId);
          }
          return [[previous, next.size > 0] as const, next] as const;
        }).pipe(
          Effect.flatMap(([previous, enabled]) =>
            previous === enabled
              ? Effect.void
              : Queue.offer(sampleTriggers, undefined).pipe(Effect.asVoid),
          ),
        );
      case "setHostPowerIntervals":
        return Ref.set(hostPowerIntervals, {
          active: Duration.millis(message.activeIntervalMs),
          idle: Duration.millis(message.idleIntervalMs),
        }).pipe(Effect.andThen(Queue.offer(sampleTriggers, undefined)), Effect.asVoid);
      case "requestDesktopUpdate":
        return Queue.offer(updateRequestQueue, message).pipe(Effect.asVoid);
    }
  };
  const removeControlSource: DesktopTelemetryPublisher["Service"]["removeControlSource"] = (
    sourceId,
  ) =>
    Ref.modify(diagnosticsDemandSources, (sources) => {
      const previous = sources.size > 0;
      const next = new Set(sources);
      next.delete(sourceId);
      return [[previous, next.size > 0] as const, next] as const;
    }).pipe(
      Effect.flatMap(([previous, enabled]) =>
        previous === enabled
          ? Effect.void
          : Queue.offer(sampleTriggers, undefined).pipe(Effect.asVoid),
      ),
    );
  const handleControl: DesktopTelemetryPublisher["Service"]["handleControl"] = (message) =>
    handleControlForSource("legacy", message);

  const snapshots = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const initial = yield* Ref.get(latest);
      return Stream.concat(
        Option.match(initial, {
          onNone: () => Stream.empty,
          onSome: Stream.make,
        }),
        Stream.fromSubscription(subscription),
      );
    }),
  );
  const updateReports = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(updateReportChanges);
      const initial = yield* Ref.get(latestUpdateReport);
      return Stream.concat(
        Option.match(initial, {
          onNone: () => Stream.empty,
          onSome: Stream.make,
        }),
        Stream.fromSubscription(subscription),
      );
    }),
  );
  const encoded = Stream.concat(
    Stream.make({
      version: 1,
      type: "desktopTelemetryHello",
      electronPid: process.pid,
    } as const),
    Stream.merge(snapshots, updateReports),
  ).pipe(Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)));

  const publishUpdateReport: DesktopTelemetryPublisher["Service"]["publishUpdateReport"] = (
    report,
  ) =>
    Ref.set(latestUpdateReport, Option.some(report)).pipe(
      Effect.andThen(PubSub.publish(updateReportChanges, report)),
      Effect.asVoid,
    );

  return DesktopTelemetryPublisher.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    encoded,
    handleControl,
    handleControlForSource,
    removeControlSource,
    publishUpdateReport,
    updateRequests: Stream.fromQueue(updateRequestQueue),
  });
});

export const layer = Layer.effect(DesktopTelemetryPublisher, make());
