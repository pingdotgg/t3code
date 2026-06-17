import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

export interface HostPowerMonitorShape {
  readonly snapshot: Effect.Effect<HostPowerSnapshot>;
  readonly report: (snapshot: HostPowerSnapshot) => Effect.Effect<void>;
  readonly setDemandActive: (active: boolean) => Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<HostPowerSnapshot>;
}

export class HostPowerMonitor extends Context.Service<HostPowerMonitor, HostPowerMonitorShape>()(
  "t3/background/HostPowerMonitor",
) {}

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
  initialSource: HostPowerSnapshot["source"] = "unknown",
) {
  const initial = makeUnknownSnapshot(initialSource, yield* DateTime.now);
  const latestRef = yield* Ref.make(initial);
  const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);

  const report: HostPowerMonitorShape["report"] = (snapshot) =>
    Ref.modify(latestRef, (current) => [!samePowerState(current, snapshot), snapshot]).pipe(
      Effect.flatMap((changed) => (changed ? PubSub.publish(changes, snapshot) : Effect.void)),
      Effect.asVoid,
    );

  return HostPowerMonitor.of({
    snapshot: Ref.get(latestRef),
    report,
    setDemandActive: () => Effect.void,
    streamChanges: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(
  HostPowerMonitor,
  Effect.gen(function* () {
    const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
    const initial = yield* telemetry.latest;
    const monitor = yield* make(initial.power.source);
    yield* monitor.report(initial.power);
    yield* telemetry.changes.pipe(
      Stream.map((snapshot) => snapshot.power),
      Stream.runForEach(monitor.report),
      Effect.forkScoped,
    );
    return monitor;
  }),
);
