import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export class HostPowerMonitor extends Context.Service<
  HostPowerMonitor,
  {
    readonly snapshot: Effect.Effect<HostPowerSnapshot>;
    readonly report: (snapshot: HostPowerSnapshot) => Effect.Effect<void>;
    readonly streamChanges: Stream.Stream<HostPowerSnapshot>;
  }
>()("t3/background/HostPowerMonitor") {}

export const makeUnknownSnapshot = (
  source: HostPowerSnapshot["source"],
  updatedAt: HostPowerSnapshot["updatedAt"],
): HostPowerSnapshot => ({
  source,
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt,
});

function samePowerState(left: HostPowerSnapshot, right: HostPowerSnapshot): boolean {
  return (
    left.source === right.source &&
    left.idle === right.idle &&
    left.locked === right.locked &&
    left.suspended === right.suspended &&
    left.onBattery === right.onBattery &&
    left.lowPowerMode === right.lowPowerMode &&
    left.thermalState === right.thermalState &&
    left.stale === right.stale
  );
}

export const make = Effect.fn("background.hostPower.make")(function* (
  initialSnapshot?: HostPowerSnapshot,
) {
  const initial = initialSnapshot ?? makeUnknownSnapshot("unknown", yield* DateTime.now);
  const latestRef = yield* Ref.make(initial);
  const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);

  const report: HostPowerMonitor["Service"]["report"] = (snapshot) =>
    Ref.modify(latestRef, (current) => {
      if (DateTime.isLessThan(snapshot.updatedAt, current.updatedAt)) {
        return [Option.none<HostPowerSnapshot>(), current] as const;
      }
      return [
        samePowerState(current, snapshot) ? Option.none() : Option.some(snapshot),
        snapshot,
      ] as const;
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (next) => PubSub.publish(changes, next),
        }),
      ),
      Effect.asVoid,
    );

  return HostPowerMonitor.of({
    snapshot: Ref.get(latestRef),
    report,
    streamChanges: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(
  HostPowerMonitor,
  Effect.gen(function* () {
    const desktopTelemetry = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const desktopSubscription = yield* desktopTelemetry.subscribe;
    const initial = desktopSubscription.latest;
    const monitor = yield* Option.match(initial, {
      onNone: () => make(),
      onSome: (snapshot) => make(snapshot.power),
    });
    yield* desktopSubscription.changes.pipe(
      Stream.map((snapshot) => snapshot.power),
      Stream.runForEach(monitor.report),
      Effect.forkScoped,
    );
    return monitor;
  }),
);
