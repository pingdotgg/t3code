import { assert, describe, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import * as LinuxHostPower from "./LinuxHostPower.ts";

function writeFile(filePath: string, contents: string): void {
  Fs.mkdirSync(Path.dirname(filePath), { recursive: true });
  Fs.writeFileSync(filePath, contents);
}

function makeSysRoot(): string {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-linux-host-power-"));
}

function writeCpufreq(
  sysRoot: string,
  cpu: string,
  values: { readonly cpuinfoMax: number; readonly scalingMax: number },
): void {
  writeFile(
    Path.join(sysRoot, "devices/system/cpu", cpu, "cpufreq/cpuinfo_max_freq"),
    `${values.cpuinfoMax}\n`,
  );
  writeFile(
    Path.join(sysRoot, "devices/system/cpu", cpu, "cpufreq/scaling_max_freq"),
    `${values.scalingMax}\n`,
  );
}

function writeZone(
  sysRoot: string,
  zone: string,
  input: {
    readonly type: string;
    readonly tempMilli: number;
    readonly mode?: string;
    readonly trips?: ReadonlyArray<{ readonly type: string; readonly tempMilli: number }>;
  },
): void {
  const zonePath = Path.join(sysRoot, "class/thermal", zone);
  writeFile(Path.join(zonePath, "type"), `${input.type}\n`);
  writeFile(Path.join(zonePath, "temp"), `${input.tempMilli}\n`);
  writeFile(Path.join(zonePath, "mode"), `${input.mode ?? "enabled"}\n`);
  for (const [index, trip] of (input.trips ?? []).entries()) {
    writeFile(Path.join(zonePath, `trip_point_${index}_type`), `${trip.type}\n`);
    writeFile(Path.join(zonePath, `trip_point_${index}_temp`), `${trip.tempMilli}\n`);
  }
}

describe("LinuxHostPower", () => {
  it("reports 100% when the advertised cap matches hardware max", () => {
    const sysRoot = makeSysRoot();
    writeCpufreq(sysRoot, "cpu0", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
    writeCpufreq(sysRoot, "cpu1", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
    assert.equal(LinuxHostPower.sample(sysRoot).speedLimitPercent, 100);
  });

  it("uses the most restrictive CPU cap", () => {
    const sysRoot = makeSysRoot();
    writeCpufreq(sysRoot, "cpu0", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
    writeCpufreq(sysRoot, "cpu1", { cpuinfoMax: 3_000_000, scalingMax: 2_400_000 });
    assert.equal(LinuxHostPower.sample(sysRoot).speedLimitPercent, 80);
  });

  it("tightens the cap with intel_pstate max_perf_pct", () => {
    const sysRoot = makeSysRoot();
    writeCpufreq(sysRoot, "cpu0", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
    writeFile(Path.join(sysRoot, "devices/system/cpu/intel_pstate/max_perf_pct"), "50\n");
    assert.equal(LinuxHostPower.sample(sysRoot).speedLimitPercent, 50);
  });

  it("returns no speed limit when cpufreq is missing", () => {
    const sysRoot = makeSysRoot();
    assert.isNull(LinuxHostPower.sample(sysRoot).speedLimitPercent);
  });

  it("maps package temp against trip points", () => {
    const sysRoot = makeSysRoot();
    writeZone(sysRoot, "thermal_zone7", {
      type: "x86_pkg_temp",
      tempMilli: 90_000,
      trips: [
        { type: "passive", tempMilli: 80_000 },
        { type: "hot", tempMilli: 95_000 },
        { type: "critical", tempMilli: 100_000 },
      ],
    });
    assert.equal(LinuxHostPower.sample(sysRoot).thermalState, "fair");
  });

  it("treats hot trips as serious and critical trips as critical", () => {
    const sysRoot = makeSysRoot();
    writeZone(sysRoot, "thermal_zone7", {
      type: "x86_pkg_temp",
      tempMilli: 96_000,
      trips: [
        { type: "hot", tempMilli: 95_000 },
        { type: "critical", tempMilli: 100_000 },
      ],
    });
    assert.equal(LinuxHostPower.sample(sysRoot).thermalState, "serious");
    writeFile(Path.join(sysRoot, "class/thermal/thermal_zone7/temp"), "100000\n");
    assert.equal(LinuxHostPower.sample(sysRoot).thermalState, "critical");
  });

  it("ignores unset kernel trip temps and prefers x86_pkg_temp", () => {
    const sysRoot = makeSysRoot();
    writeZone(sysRoot, "thermal_zone2", {
      type: "TSKN",
      tempMilli: 70_000,
      trips: [{ type: "passive", tempMilli: 66_000 }],
    });
    writeZone(sysRoot, "thermal_zone7", {
      type: "x86_pkg_temp",
      tempMilli: 52_000,
      trips: [
        { type: "passive", tempMilli: -274_000 },
        { type: "passive", tempMilli: -274_000 },
      ],
    });
    assert.equal(LinuxHostPower.sample(sysRoot).thermalState, "nominal");
  });

  it("skips disabled zones and wifi sensors", () => {
    const sysRoot = makeSysRoot();
    writeZone(sysRoot, "thermal_zone3", {
      type: "INT3400 Thermal",
      tempMilli: 20_000,
      mode: "disabled",
    });
    writeZone(sysRoot, "thermal_zone8", {
      type: "iwlwifi_1",
      tempMilli: 80_000,
      trips: [{ type: "passive", tempMilli: 40_000 }],
    });
    writeZone(sysRoot, "thermal_zone0", {
      type: "acpitz",
      tempMilli: 40_000,
    });
    assert.equal(LinuxHostPower.sample(sysRoot).thermalState, "nominal");
  });

  it("leaves unknown when sysfs has no thermal zones", () => {
    const sysRoot = makeSysRoot();
    assert.equal(LinuxHostPower.sample(sysRoot).thermalState, "unknown");
  });

  it("does not override Electron values that are already known", () => {
    const filled = LinuxHostPower.fillElectronGaps("nominal", 90, {
      thermalState: "critical",
      speedLimitPercent: 40,
    });
    assert.equal(filled.thermalState, "nominal");
    assert.equal(filled.speedLimitPercent, 90);
  });

  it("fills Electron unknown/null gaps from sysfs", () => {
    const filled = LinuxHostPower.fillElectronGaps("unknown", null, {
      thermalState: "fair",
      speedLimitPercent: 80,
    });
    assert.equal(filled.thermalState, "fair");
    assert.equal(filled.speedLimitPercent, 80);
  });
});
