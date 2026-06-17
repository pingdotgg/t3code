import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetrySnapshot,
  type DesktopTelemetryControlMessage,
  type HostPowerSnapshot,
} from "@t3tools/contracts";
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
const BACKGROUND_HEARTBEAT_INTERVAL = Duration.seconds(30);
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
  readonly locked: HostPowerSnapshot["locked"];
  readonly suspended: boolean;
  readonly onBattery: HostPowerSnapshot["onBattery"];
  readonly thermalState: HostPowerSnapshot["thermalState"];
  readonly speedLimitPercent: Option.Option<number>;
}

export interface DesktopTelemetryPublisherShape {
  readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
  readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
  readonly encoded: Stream.Stream<Uint8Array>;
  readonly handleControl: (message: DesktopTelemetryControlMessage) => Effect.Effect<void>;
}

export class DesktopTelemetryPublisher extends Context.Service<
  DesktopTelemetryPublisher,
  DesktopTelemetryPublisherShape
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
      return { ...state, locked: booleanState(event.value) };
    case "suspended":
      return { ...state, suspended: event.value };
    case "onBattery":
      return { ...state, onBattery: booleanState(event.value) };
    case "thermal":
      return { ...state, thermalState: event.value };
    case "speedLimit":
      return { ...state, speedLimitPercent: Option.some(event.value) };
  }
}

function sampleInterval(power: PowerState, diagnosticsDemand: boolean): Duration.Duration {
  if (!diagnosticsDemand) return BACKGROUND_HEARTBEAT_INTERVAL;
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
    locked: "unknown",
    suspended: false,
    onBattery: booleanState(yield* powerMonitor.isOnBatteryPower),
    thermalState: yield* powerMonitor.getCurrentThermalState,
    speedLimitPercent: Option.none(),
  };
  const powerState = yield* Ref.make(initialPowerState);
  const powerEvents = yield* Queue.unbounded<PowerEvent>();
  const sampleTriggers = yield* Queue.sliding<void>(1);
  const diagnosticsDemand = yield* Ref.make(false);
  const latest = yield* Ref.make(Option.none<DesktopHostTelemetrySnapshot>());
  const changes = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(8);
  const sequence = yield* Ref.make(0);

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

  const sampleOnce = Effect.gen(function* () {
    const sampledAt = yield* DateTime.now;
    const sampledAtUnixMs = DateTime.toEpochMillis(sampledAt);
    const demand = yield* Ref.get(diagnosticsDemand);
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
    const nextSequence = yield* Ref.modify(sequence, (current) => [current + 1, current + 1]);
    const locked = systemIdleState === "locked" ? "true" : currentPower.locked;
    const snapshot: DesktopHostTelemetrySnapshot = {
      version: 1,
      type: "desktopTelemetry",
      sequence: nextSequence,
      sampledAtUnixMs,
      electronPid: process.pid,
      power: {
        source: "electron-main",
        idle: idleState(systemIdleState),
        idleSeconds,
        locked,
        suspended: currentPower.suspended,
        onBattery: booleanState(onBattery),
        lowPowerMode: "unknown",
        thermalState: currentPower.thermalState,
        stale: false,
        updatedAt: sampledAt,
      },
      speedLimitPercent: currentPower.speedLimitPercent,
      electronProcesses: metrics.map((metric) => ({
        pid: metric.pid,
        creationTimeMs: metric.creationTime,
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
      Effect.logWarning("Failed to sample Electron telemetry", {
        cause: String(cause),
      }),
    ),
  );

  yield* Effect.gen(function* () {
    yield* sampleOnce;
    while (true) {
      const [currentPower, demand] = yield* Effect.all([
        Ref.get(powerState),
        Ref.get(diagnosticsDemand),
      ]);
      yield* Effect.raceFirst(
        Queue.take(sampleTriggers),
        Effect.sleep(sampleInterval(currentPower, demand)),
      );
      yield* sampleOnce;
    }
  }).pipe(Effect.forkScoped);

  const handleControl: DesktopTelemetryPublisherShape["handleControl"] = (message) => {
    switch (message.type) {
      case "setDiagnosticsDemand":
        return Ref.getAndSet(diagnosticsDemand, message.enabled).pipe(
          Effect.flatMap((previous) =>
            previous === message.enabled
              ? Effect.void
              : Queue.offer(sampleTriggers, undefined).pipe(Effect.asVoid),
          ),
        );
    }
  };

  const snapshots = Stream.concat(
    Stream.unwrap(
      Ref.get(latest).pipe(
        Effect.map(
          Option.match({
            onNone: () => Stream.empty,
            onSome: Stream.make,
          }),
        ),
      ),
    ),
    Stream.fromPubSub(changes),
  );
  const encoded = Stream.concat(
    Stream.make({
      version: 1,
      type: "desktopTelemetryHello",
      electronPid: process.pid,
    } as const),
    snapshots,
  ).pipe(Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)));

  return DesktopTelemetryPublisher.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    encoded,
    handleControl,
  });
});

export const layer = Layer.effect(DesktopTelemetryPublisher, make());
