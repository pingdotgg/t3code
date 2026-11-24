import {
  DesktopLinkMessage,
  type DesktopLinkSnapshot,
  type DesktopLinkControlMessage,
  type DesktopLinkCancelDesktopUpdate,
  type DesktopLinkCommitDesktopUpdate,
  type DesktopLinkRequestDesktopUpdate,
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
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
const DEFAULT_HOST_POWER_ACTIVE_INTERVAL = Duration.seconds(30);
const DEFAULT_HOST_POWER_IDLE_INTERVAL = Duration.minutes(2);
const IDLE_THRESHOLD_SECONDS = 60;
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(DesktopLinkMessage));
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

export class DesktopLinkPublisher extends Context.Service<
  DesktopLinkPublisher,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopLinkSnapshot>>;
    readonly changes: Stream.Stream<DesktopLinkSnapshot>;
    readonly encoded: Stream.Stream<Uint8Array>;
    readonly handleControlForSource: (
      sourceId: string,
      message: DesktopLinkControlMessage,
    ) => Effect.Effect<void>;
    readonly removeControlSource: (sourceId: string) => Effect.Effect<void>;
    readonly publishUpdateReport: (report: DesktopUpdateStatusReport) => Effect.Effect<void>;
    readonly updateRequests: Stream.Stream<DesktopLinkRequestDesktopUpdate>;
    readonly updateCommits: Stream.Stream<DesktopLinkCommitDesktopUpdate>;
    readonly updateCancellations: Stream.Stream<DesktopLinkCancelDesktopUpdate>;
  }
>()("@t3tools/desktop/desktopLink/DesktopLinkPublisher") {}

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
  hostPowerIntervals: HostPowerIntervals,
): Duration.Duration {
  return power.suspended || power.locked === "true" || power.idle === "true"
    ? hostPowerIntervals.idle
    : hostPowerIntervals.active;
}

/** @public */
export const make = Effect.fn("desktop.telemetryPublisher.make")(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
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
  const latest = yield* Ref.make(Option.none<DesktopLinkSnapshot>());
  const changes = yield* PubSub.sliding<DesktopLinkSnapshot>(8);
  const sequence = yield* Ref.make(0);
  const latestUpdateReport = yield* Ref.make(Option.none<DesktopUpdateStatusReport>());
  const updateReportChanges = yield* PubSub.sliding<DesktopUpdateStatusReport>(16);
  const updateRequestQueue = yield* Queue.unbounded<DesktopLinkRequestDesktopUpdate>();
  const updateCommitQueue = yield* Queue.unbounded<DesktopLinkCommitDesktopUpdate>();
  const updateCancellationQueue = yield* Queue.unbounded<DesktopLinkCancelDesktopUpdate>();

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

  const sampleOnce =
    /* Periodic sampling should not generate its own tracing traffic. */
    Effect.fnUntraced(
      function* (allowSuspendRecovery: boolean) {
        const sampledAt = yield* DateTime.now;
        const sampledAtUnixMs = DateTime.toEpochMillis(sampledAt);
        const [currentPower, idleSeconds, systemIdleState, onBattery] = yield* Effect.all(
          [
            Ref.get(powerState),
            powerMonitor.getSystemIdleTime,
            powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS),
            powerMonitor.isOnBatteryPower,
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
        const snapshot: DesktopLinkSnapshot = {
          version: 1,
          type: "desktopLink",
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
        };

        yield* Ref.set(latest, Option.some(snapshot));
        yield* PubSub.publish(changes, snapshot);
      },
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("Failed to read the computer's power state", {
            cause: String(cause),
          }),
      ),
    );

  yield* Effect.gen(function* () {
    yield* sampleOnce(false);
    while (true) {
      const [currentPower, intervals] = yield* Effect.all([
        Ref.get(powerState),
        Ref.get(hostPowerIntervals),
      ]);
      // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races a trigger queue against the interval; both arms are real outcomes, not a timeout
      const allowSuspendRecovery = yield* Effect.raceFirst(
        Queue.take(sampleTriggers).pipe(Effect.as(false)),
        Effect.sleep(sampleInterval(currentPower, intervals)).pipe(Effect.as(true)),
      );
      yield* sampleOnce(allowSuspendRecovery);
    }
  }).pipe(Effect.forkScoped);

  const handleControlForSource: DesktopLinkPublisher["Service"]["handleControlForSource"] = (
    sourceId,
    message,
  ) => {
    switch (message.type) {
      case "setHostPowerIntervals":
        return Ref.set(hostPowerIntervals, {
          active: Duration.millis(message.activeIntervalMs),
          idle: Duration.millis(message.idleIntervalMs),
        }).pipe(Effect.andThen(Queue.offer(sampleTriggers, undefined)), Effect.asVoid);
      case "requestDesktopUpdate":
        return Queue.offer(updateRequestQueue, message).pipe(Effect.asVoid);
      case "commitDesktopUpdate":
        return Queue.offer(updateCommitQueue, message).pipe(Effect.asVoid);
      case "cancelDesktopUpdate":
        return Queue.offer(updateCancellationQueue, message).pipe(Effect.asVoid);
      case "serverReady":
        return Effect.void;
    }
  };
  const removeControlSource: DesktopLinkPublisher["Service"]["removeControlSource"] = (sourceId) =>
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
      type: "desktopLinkHello",
      electronPid: process.pid,
    } as const),
    Stream.merge(Stream.merge(snapshots, updateReports), shellEnvironment.updates),
  ).pipe(Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)));

  const publishUpdateReport: DesktopLinkPublisher["Service"]["publishUpdateReport"] = (report) =>
    Ref.set(latestUpdateReport, Option.some(report)).pipe(
      Effect.andThen(PubSub.publish(updateReportChanges, report)),
      Effect.asVoid,
    );

  return DesktopLinkPublisher.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    encoded,
    handleControlForSource,
    removeControlSource,
    publishUpdateReport,
    updateRequests: Stream.fromQueue(updateRequestQueue),
    updateCommits: Stream.fromQueue(updateCommitQueue),
    updateCancellations: Stream.fromQueue(updateCancellationQueue),
  });
});

export const layer = Layer.effect(DesktopLinkPublisher, make());
