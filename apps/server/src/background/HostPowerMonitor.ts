import {
  type BackgroundBooleanState,
  type HostPowerSnapshot,
  type HostPowerThermalState,
} from "@t3tools/contracts";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export interface HostPowerMonitorShape {
  readonly snapshot: Effect.Effect<HostPowerSnapshot>;
  readonly report: (snapshot: HostPowerSnapshot) => Effect.Effect<void>;
  readonly setDemandActive: (active: boolean) => Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<HostPowerSnapshot>;
}

export class HostPowerMonitor extends Context.Service<HostPowerMonitor, HostPowerMonitorShape>()(
  "t3/background/HostPowerMonitor",
) {}

const COMMAND_TIMEOUT = Duration.seconds(3);

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

function boolState(value: boolean | null): BackgroundBooleanState {
  if (value === null) return "unknown";
  return value ? "true" : "false";
}

function parseIdleSeconds(ioregOutput: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(ioregOutput);
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  return Number.isFinite(nanoseconds) ? Math.floor(nanoseconds / 1_000_000_000) : null;
}

function parseOnBattery(pmsetBatteryOutput: string): boolean | null {
  if (/Now drawing from 'Battery Power'/iu.test(pmsetBatteryOutput)) return true;
  if (/Now drawing from 'AC Power'/iu.test(pmsetBatteryOutput)) return false;
  return null;
}

function parseLowPowerMode(pmsetOutput: string): boolean | null {
  const match = /^\s*lowpowermode\s+([01])\s*$/imu.exec(pmsetOutput);
  if (!match) return null;
  return match[1] === "1";
}

function parseThermalState(_output: string): HostPowerThermalState {
  // The stable shell adapter intentionally does not parse `pmset thermlog`;
  // native adapters can provide this without depending on human-formatted text.
  return "unknown";
}

function runOptional(
  runner: ProcessRunner.ProcessRunnerShape,
  command: string,
  args: ReadonlyArray<string>,
) {
  return runner
    .run({
      command,
      args,
      timeout: COMMAND_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      outputMode: "truncate",
      maxOutputBytes: 32_000,
    })
    .pipe(Effect.option);
}

const readMacShellSnapshot = Effect.fn("background.hostPower.readMacShellSnapshot")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const updatedAt = yield* DateTime.now;
  const [idleOutput, batteryOutput, pmsetOutput] = yield* Effect.all(
    [
      runOptional(runner, "ioreg", ["-c", "IOHIDSystem"]),
      runOptional(runner, "pmset", ["-g", "batt"]),
      runOptional(runner, "pmset", ["-g"]),
    ],
    { concurrency: "unbounded" },
  );

  const idleSeconds = idleOutput._tag === "Some" ? parseIdleSeconds(idleOutput.value.stdout) : null;
  const onBattery =
    batteryOutput._tag === "Some" ? parseOnBattery(batteryOutput.value.stdout) : null;
  const lowPowerMode =
    pmsetOutput._tag === "Some" ? parseLowPowerMode(pmsetOutput.value.stdout) : null;

  return {
    source: "node-macos-shell",
    idle: boolState(idleSeconds === null ? null : idleSeconds >= 60),
    idleSeconds,
    locked: "unknown",
    suspended: false,
    onBattery: boolState(onBattery),
    lowPowerMode: boolState(lowPowerMode),
    thermalState: parseThermalState(""),
    stale: false,
    updatedAt,
  } satisfies HostPowerSnapshot;
});

export const make = Effect.fn("background.hostPower.make")(function* (
  initialSource: HostPowerSnapshot["source"] = "unknown",
) {
  const initial = makeUnknownSnapshot(initialSource, yield* DateTime.now);
  const latestRef = yield* Ref.make(initial);
  const demandActiveRef = yield* Ref.make(false);
  const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);

  const report: HostPowerMonitorShape["report"] = (snapshot) =>
    Ref.set(latestRef, snapshot).pipe(
      Effect.andThen(PubSub.publish(changes, snapshot)),
      Effect.asVoid,
    );

  return HostPowerMonitor.of({
    snapshot: Ref.get(latestRef),
    report,
    setDemandActive: (active) => Ref.set(demandActiveRef, active),
    streamChanges: Stream.fromPubSub(changes),
  });
});

const unknownLayer = Layer.effect(HostPowerMonitor, make("unknown"));
const linuxLayer = Layer.effect(HostPowerMonitor, make("node-linux"));
const windowsLayer = Layer.effect(HostPowerMonitor, make("node-windows"));

const macShellLayer = Layer.effect(
  HostPowerMonitor,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const monitor = yield* make("node-macos-shell");
    const demandActiveRef = yield* Ref.make(true);
    const setDemandActive: HostPowerMonitorShape["setDemandActive"] = (active) =>
      Ref.set(demandActiveRef, active);
    const getPollInterval = Effect.gen(function* () {
      const demandActive = yield* Ref.get(demandActiveRef);
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map(resolveServerBackgroundActivitySettings),
        Effect.catch(() => Effect.succeed(getBackgroundActivityPresetSettings("balanced"))),
      );
      return demandActive
        ? settings.hostPowerMonitorActiveInterval
        : settings.hostPowerMonitorIdleInterval;
    });
    const adaptiveMonitor = HostPowerMonitor.of({
      snapshot: monitor.snapshot,
      report: monitor.report,
      setDemandActive,
      streamChanges: monitor.streamChanges,
    });
    yield* readMacShellSnapshot().pipe(
      Effect.flatMap(adaptiveMonitor.report),
      Effect.ignoreCause({ log: true }),
    );
    yield* Effect.forever(
      getPollInterval.pipe(
        Effect.flatMap((interval) => Effect.sleep(Duration.max(interval, Duration.seconds(5)))),
        Effect.andThen(readMacShellSnapshot()),
        Effect.flatMap(adaptiveMonitor.report),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);
    return adaptiveMonitor;
  }),
).pipe(Layer.provide(ProcessRunner.layer));

export const layer = Layer.unwrap(
  Effect.sync(() => {
    switch (process.platform) {
      case "darwin":
        return macShellLayer;
      case "linux":
        return linuxLayer;
      case "win32":
        return windowsLayer;
      default:
        return unknownLayer;
    }
  }),
);
