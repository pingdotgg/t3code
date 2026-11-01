import * as Fs from "node:fs";
import * as Path from "node:path";

export type LinuxThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";

export interface LinuxHostPowerSample {
  readonly thermalState: LinuxThermalState;
  readonly speedLimitPercent: number | null;
}

const PREFERRED_THERMAL_TYPES = ["x86_pkg_temp", "acpitz"] as const;

function readTrimmed(filePath: string): string | null {
  try {
    return Fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

function readInt(filePath: string): number | null {
  const text = readTrimmed(filePath);
  if (text === null || text === "") return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

function listNumericSuffix(directory: string, prefix: string): string[] {
  try {
    return Fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && /^[0-9]+$/.test(name.slice(prefix.length)))
      .sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)));
  } catch {
    return [];
  }
}

function sampleSpeedLimitPercent(sysRoot: string): number | null {
  const cpuRoot = Path.join(sysRoot, "devices/system/cpu");
  let minRatio = 1;
  let foundCpufreq = false;
  for (const cpu of listNumericSuffix(cpuRoot, "cpu")) {
    const cpufreq = Path.join(cpuRoot, cpu, "cpufreq");
    const hardwareMax = readInt(Path.join(cpufreq, "cpuinfo_max_freq"));
    const advertisedMax = readInt(Path.join(cpufreq, "scaling_max_freq"));
    if (hardwareMax === null || advertisedMax === null || hardwareMax <= 0) continue;
    foundCpufreq = true;
    minRatio = Math.min(minRatio, advertisedMax / hardwareMax);
  }
  const maxPerfPct = readInt(Path.join(cpuRoot, "intel_pstate", "max_perf_pct"));
  if (maxPerfPct !== null && maxPerfPct >= 0 && maxPerfPct <= 100) {
    minRatio = Math.min(minRatio, maxPerfPct / 100);
    foundCpufreq = true;
  }
  if (!foundCpufreq) return null;
  return Math.min(100, Math.max(0, Math.round(minRatio * 100)));
}

interface ThermalTrip {
  readonly type: string;
  readonly tempMilli: number;
}

function readTrips(zonePath: string): ThermalTrip[] {
  const trips: ThermalTrip[] = [];
  let index = 0;
  while (true) {
    const type = readTrimmed(Path.join(zonePath, `trip_point_${index}_type`));
    if (type === null) break;
    const tempMilli = readInt(Path.join(zonePath, `trip_point_${index}_temp`));
    index += 1;
    // Kernel writes -274000 millicelsius for an unset trip.
    if (tempMilli === null || tempMilli < 0) continue;
    trips.push({ type, tempMilli });
  }
  return trips;
}

function thermalStateFromZone(zonePath: string): LinuxThermalState | null {
  const mode = readTrimmed(Path.join(zonePath, "mode"));
  if (mode === "disabled") return null;
  const tempMilli = readInt(Path.join(zonePath, "temp"));
  if (tempMilli === null) return null;
  const trips = readTrips(zonePath);
  const crossed = (kind: string): boolean =>
    trips.some((trip) => trip.type === kind && tempMilli >= trip.tempMilli);
  if (crossed("critical")) return "critical";
  if (crossed("hot")) return "serious";
  if (crossed("passive") || crossed("active")) return "fair";
  return "nominal";
}

function sampleThermalState(sysRoot: string): LinuxThermalState {
  const thermalRoot = Path.join(sysRoot, "class/thermal");
  const zoneNames = listNumericSuffix(thermalRoot, "thermal_zone");
  if (zoneNames.length === 0) return "unknown";
  const zones = zoneNames.map((name) => {
    const zonePath = Path.join(thermalRoot, name);
    return {
      type: readTrimmed(Path.join(zonePath, "type")) ?? "",
      zonePath,
    };
  });
  for (const preferred of PREFERRED_THERMAL_TYPES) {
    const match = zones.find((zone) => zone.type === preferred);
    if (match === undefined) continue;
    const state = thermalStateFromZone(match.zonePath);
    if (state !== null) return state;
  }
  for (const zone of zones) {
    if (zone.type.startsWith("iwlwifi")) continue;
    const state = thermalStateFromZone(zone.zonePath);
    if (state !== null) return state;
  }
  return "unknown";
}

export function sample(sysRoot = "/sys"): LinuxHostPowerSample {
  try {
    return {
      thermalState: sampleThermalState(sysRoot),
      speedLimitPercent: sampleSpeedLimitPercent(sysRoot),
    };
  } catch {
    return { thermalState: "unknown", speedLimitPercent: null };
  }
}

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
