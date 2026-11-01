import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type LinuxThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";

export interface LinuxHostPowerSample {
  readonly thermalState: LinuxThermalState;
  readonly speedLimitPercent: number | null;
}

const PREFERRED_THERMAL_TYPES = ["x86_pkg_temp", "acpitz"] as const;

const readTrimmed = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.map((text) => {
      const trimmed = text.trim();
      return trimmed === "" ? null : trimmed;
    }),
    Effect.orElseSucceed(() => null),
  );

const readInt = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  readTrimmed(fileSystem, filePath).pipe(
    Effect.map((text) => {
      if (text === null) return null;
      const value = Number.parseInt(text, 10);
      return Number.isFinite(value) ? value : null;
    }),
  );

const listNumericSuffix = (fileSystem: FileSystem.FileSystem, directory: string, prefix: string) =>
  fileSystem.readDirectory(directory).pipe(
    Effect.orElseSucceed((): string[] => []),
    Effect.map((names) =>
      names
        .filter((name) => name.startsWith(prefix) && /^[0-9]+$/.test(name.slice(prefix.length)))
        .sort(
          (left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)),
        ),
    ),
  );

const sampleSpeedLimitPercent = Effect.fn("LinuxHostPower.sampleSpeedLimitPercent")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  sysRoot: string,
) {
  const cpuRoot = path.join(sysRoot, "devices/system/cpu");
  const cpus = yield* listNumericSuffix(fileSystem, cpuRoot, "cpu");
  let minRatio = 1;
  let foundCpufreq = false;
  for (const cpu of cpus) {
    const cpufreq = path.join(cpuRoot, cpu, "cpufreq");
    const hardwareMax = yield* readInt(fileSystem, path.join(cpufreq, "cpuinfo_max_freq"));
    const advertisedMax = yield* readInt(fileSystem, path.join(cpufreq, "scaling_max_freq"));
    if (hardwareMax === null || advertisedMax === null || hardwareMax <= 0) continue;
    foundCpufreq = true;
    minRatio = Math.min(minRatio, advertisedMax / hardwareMax);
  }
  const maxPerfPct = yield* readInt(fileSystem, path.join(cpuRoot, "intel_pstate", "max_perf_pct"));
  if (maxPerfPct !== null && maxPerfPct >= 0 && maxPerfPct <= 100) {
    minRatio = Math.min(minRatio, maxPerfPct / 100);
    foundCpufreq = true;
  }
  if (!foundCpufreq) return null;
  return Math.min(100, Math.max(0, Math.round(minRatio * 100)));
});

interface ThermalTrip {
  readonly type: string;
  readonly tempMilli: number;
}

const readTrips = Effect.fn("LinuxHostPower.readTrips")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  zonePath: string,
) {
  const trips: ThermalTrip[] = [];
  let index = 0;
  while (true) {
    const type = yield* readTrimmed(fileSystem, path.join(zonePath, `trip_point_${index}_type`));
    if (type === null) break;
    const tempMilli = yield* readInt(fileSystem, path.join(zonePath, `trip_point_${index}_temp`));
    index += 1;
    // Kernel writes -274000 millicelsius for an unset trip.
    if (tempMilli === null || tempMilli < 0) continue;
    trips.push({ type, tempMilli });
  }
  return trips;
});

const thermalStateFromZone = Effect.fn("LinuxHostPower.thermalStateFromZone")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  zonePath: string,
) {
  const mode = yield* readTrimmed(fileSystem, path.join(zonePath, "mode"));
  if (mode === "disabled") return null;
  const tempMilli = yield* readInt(fileSystem, path.join(zonePath, "temp"));
  if (tempMilli === null) return null;
  const trips = yield* readTrips(fileSystem, path, zonePath);
  const crossed = (kind: string): boolean =>
    trips.some((trip) => trip.type === kind && tempMilli >= trip.tempMilli);
  if (crossed("critical")) return "critical" as const;
  if (crossed("hot")) return "serious" as const;
  if (crossed("passive") || crossed("active")) return "fair" as const;
  return "nominal" as const;
});

const sampleThermalState = Effect.fn("LinuxHostPower.sampleThermalState")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  sysRoot: string,
) {
  const thermalRoot = path.join(sysRoot, "class/thermal");
  const zoneNames = yield* listNumericSuffix(fileSystem, thermalRoot, "thermal_zone");
  if (zoneNames.length === 0) return "unknown" as const;
  const zones = yield* Effect.forEach(zoneNames, (name) =>
    Effect.gen(function* () {
      const zonePath = path.join(thermalRoot, name);
      return {
        type: (yield* readTrimmed(fileSystem, path.join(zonePath, "type"))) ?? "",
        zonePath,
      };
    }),
  );
  for (const preferred of PREFERRED_THERMAL_TYPES) {
    const match = zones.find((zone) => zone.type === preferred);
    if (match === undefined) continue;
    const state = yield* thermalStateFromZone(fileSystem, path, match.zonePath);
    if (state !== null) return state;
  }
  for (const zone of zones) {
    if (zone.type.startsWith("iwlwifi")) continue;
    const state = yield* thermalStateFromZone(fileSystem, path, zone.zonePath);
    if (state !== null) return state;
  }
  return "unknown" as const;
});

const unknownSample: LinuxHostPowerSample = {
  thermalState: "unknown",
  speedLimitPercent: null,
};

/* Sysfs fills run on the host-power sample interval. */
export const sample = Effect.fnUntraced(
  function* (sysRoot: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.all(
      {
        thermalState: sampleThermalState(fileSystem, path, sysRoot),
        speedLimitPercent: sampleSpeedLimitPercent(fileSystem, path, sysRoot),
      },
      { concurrency: "unbounded" },
    );
  },
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterrupts(cause),
    () => Effect.succeed(unknownSample),
  ),
);

export function fillElectronGaps(
  thermalState: LinuxThermalState,
  speedLimitPercent: number | null,
  linuxSample: LinuxHostPowerSample,
): LinuxHostPowerSample {
  return {
    thermalState: thermalState === "unknown" ? linuxSample.thermalState : thermalState,
    speedLimitPercent: speedLimitPercent ?? linuxSample.speedLimitPercent,
  };
}
