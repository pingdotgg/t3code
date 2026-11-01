import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as LinuxHostPower from "./LinuxHostPower.ts";

const writeFile = (filePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const makeSysRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-linux-host-power-" });
});

const writeCpufreq = (
  sysRoot: string,
  cpu: string,
  values: { readonly cpuinfoMax: number; readonly scalingMax: number },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cpufreq = path.join(sysRoot, "devices/system/cpu", cpu, "cpufreq");
    yield* writeFile(path.join(cpufreq, "cpuinfo_max_freq"), `${values.cpuinfoMax}\n`);
    yield* writeFile(path.join(cpufreq, "scaling_max_freq"), `${values.scalingMax}\n`);
  });

const writeZone = (
  sysRoot: string,
  zone: string,
  input: {
    readonly type: string;
    readonly tempMilli: number;
    readonly mode?: string;
    readonly trips?: ReadonlyArray<{ readonly type: string; readonly tempMilli: number }>;
  },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const zonePath = path.join(sysRoot, "class/thermal", zone);
    yield* writeFile(path.join(zonePath, "type"), `${input.type}\n`);
    yield* writeFile(path.join(zonePath, "temp"), `${input.tempMilli}\n`);
    yield* writeFile(path.join(zonePath, "mode"), `${input.mode ?? "enabled"}\n`);
    for (const [index, trip] of (input.trips ?? []).entries()) {
      yield* writeFile(path.join(zonePath, `trip_point_${index}_type`), `${trip.type}\n`);
      yield* writeFile(path.join(zonePath, `trip_point_${index}_temp`), `${trip.tempMilli}\n`);
    }
  });

it.layer(NodeServices.layer)("LinuxHostPower", (it) => {
  it.effect("reports 100% when the advertised cap matches hardware max", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      yield* writeCpufreq(sysRoot, "cpu0", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
      yield* writeCpufreq(sysRoot, "cpu1", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).speedLimitPercent, 100);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the most restrictive CPU cap", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      yield* writeCpufreq(sysRoot, "cpu0", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
      yield* writeCpufreq(sysRoot, "cpu1", { cpuinfoMax: 3_000_000, scalingMax: 2_400_000 });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).speedLimitPercent, 80);
    }).pipe(Effect.scoped),
  );

  it.effect("tightens the cap with intel_pstate max_perf_pct", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      const path = yield* Path.Path;
      yield* writeCpufreq(sysRoot, "cpu0", { cpuinfoMax: 3_000_000, scalingMax: 3_000_000 });
      yield* writeFile(path.join(sysRoot, "devices/system/cpu/intel_pstate/max_perf_pct"), "50\n");
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).speedLimitPercent, 50);
    }).pipe(Effect.scoped),
  );

  it.effect("returns no speed limit when cpufreq is missing", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      assert.isNull((yield* LinuxHostPower.sample(sysRoot)).speedLimitPercent);
    }).pipe(Effect.scoped),
  );

  it.effect("maps package temp against trip points", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      yield* writeZone(sysRoot, "thermal_zone7", {
        type: "x86_pkg_temp",
        tempMilli: 90_000,
        trips: [
          { type: "passive", tempMilli: 80_000 },
          { type: "hot", tempMilli: 95_000 },
          { type: "critical", tempMilli: 100_000 },
        ],
      });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "fair");
      yield* writeZone(sysRoot, "thermal_zone8", {
        type: "x86_pkg_temp",
        tempMilli: 100_000,
        trips: [{ type: "critical", tempMilli: 100_000 }],
      });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "critical");
    }).pipe(Effect.scoped),
  );

  it.effect("treats hot trips as serious and critical trips as critical", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      const path = yield* Path.Path;
      yield* writeZone(sysRoot, "thermal_zone7", {
        type: "x86_pkg_temp",
        tempMilli: 96_000,
        trips: [
          { type: "hot", tempMilli: 95_000 },
          { type: "critical", tempMilli: 100_000 },
        ],
      });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "serious");
      yield* writeFile(path.join(sysRoot, "class/thermal/thermal_zone7/temp"), "100000\n");
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "critical");
    }).pipe(Effect.scoped),
  );

  it.effect("falls back from unset package trips to usable zones", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      yield* writeZone(sysRoot, "thermal_zone2", {
        type: "TSKN",
        tempMilli: 70_000,
        trips: [{ type: "passive", tempMilli: 66_000 }],
      });
      yield* writeZone(sysRoot, "thermal_zone7", {
        type: "x86_pkg_temp",
        tempMilli: 52_000,
        trips: [
          { type: "passive", tempMilli: -274_000 },
          { type: "passive", tempMilli: 0 },
        ],
      });
      yield* writeZone(sysRoot, "thermal_zone9", {
        type: "acpitz",
        tempMilli: 96_000,
        trips: [{ type: "hot", tempMilli: 95_000 }],
      });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "serious");
    }).pipe(Effect.scoped),
  );

  it.effect("skips disabled zones and wifi sensors", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      yield* writeZone(sysRoot, "thermal_zone3", {
        type: "INT3400 Thermal",
        tempMilli: 20_000,
        mode: "disabled",
      });
      yield* writeZone(sysRoot, "thermal_zone8", {
        type: "iwlwifi_1",
        tempMilli: 80_000,
        trips: [{ type: "passive", tempMilli: 40_000 }],
      });
      yield* writeZone(sysRoot, "thermal_zone0", {
        type: "acpitz",
        tempMilli: 40_000,
        trips: [{ type: "passive", tempMilli: 50_000 }],
      });
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "nominal");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves unknown when sysfs has no thermal zones", () =>
    Effect.gen(function* () {
      const sysRoot = yield* makeSysRoot;
      assert.equal((yield* LinuxHostPower.sample(sysRoot)).thermalState, "unknown");
    }).pipe(Effect.scoped),
  );

  it.effect("does not override Electron values that are already known", () =>
    Effect.sync(() => {
      const filled = LinuxHostPower.fillElectronGaps("nominal", 90, {
        thermalState: "critical",
        speedLimitPercent: 40,
      });
      assert.equal(filled.thermalState, "nominal");
      assert.equal(filled.speedLimitPercent, 90);
    }),
  );

  it.effect("fills Electron unknown/null gaps from sysfs", () =>
    Effect.sync(() => {
      const filled = LinuxHostPower.fillElectronGaps("unknown", null, {
        thermalState: "fair",
        speedLimitPercent: 80,
      });
      assert.equal(filled.thermalState, "fair");
      assert.equal(filled.speedLimitPercent, 80);
    }),
  );
});
