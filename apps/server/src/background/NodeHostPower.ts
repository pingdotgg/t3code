import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readHostBattery } from "@t3tools/shared/readHostBatteryPercent";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const SAMPLE_INTERVAL = Duration.seconds(30);

const hostPowerSource = (platform: NodeJS.Platform): HostPowerSnapshot["source"] | null => {
  switch (platform) {
    case "darwin":
      return "node-macos-shell";
    case "linux":
      return "node-linux";
    case "win32":
      return "node-windows";
    default:
      return null;
  }
};

const booleanState = (value: boolean): HostPowerSnapshot["onBattery"] => (value ? "true" : "false");

/**
 * Fills host battery life when Electron is not feeding power telemetry
 * (headless `npx t3` / `vp run dev` on a laptop).
 */
export const layer: Layer.Layer<never, never, HostPowerMonitor.HostPowerMonitor> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const platform = HostProcess.Platform.defaultValue();
      const source = hostPowerSource(platform);
      if (source === null) return;
      const monitor = yield* HostPowerMonitor.HostPowerMonitor;

      const sample = Effect.gen(function* () {
        const current = yield* monitor.snapshot;
        if (current.source === "electron-main" && !current.stale) return;

        const battery = readHostBattery(platform);
        const updatedAt = yield* DateTime.now;
        if (battery.percent === null && battery.onBattery === null) {
          // Drop obsolete headless readings so BackgroundPolicy does not stay paused.
          if (current.source === source && !current.stale) {
            yield* monitor.report({ ...current, stale: true, updatedAt });
          }
          return;
        }

        yield* monitor.report({
          source,
          idle: current.source === source ? current.idle : "unknown",
          idleSeconds: current.source === source ? current.idleSeconds : null,
          locked: current.source === source ? current.locked : "unknown",
          suspended: current.source === source ? current.suspended : false,
          onBattery: battery.onBattery === null ? "unknown" : booleanState(battery.onBattery),
          ...(battery.percent === null ? {} : { batteryPercent: battery.percent }),
          lowPowerMode: current.source === source ? current.lowPowerMode : "unknown",
          thermalState: current.source === source ? current.thermalState : "unknown",
          stale: false,
          updatedAt,
        });
      }).pipe(Effect.withSpan("NodeHostPower.sample"));

      yield* sample;
      yield* sample.pipe(Effect.repeat(Schedule.spaced(SAMPLE_INTERVAL)), Effect.forkScoped);
    }),
  );
