import type { HostPowerSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { resolveNativeSampleIntervalMs } from "./NativeTelemetryClient.ts";

const basePower: HostPowerSnapshot = {
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
};

describe("resolveNativeSampleIntervalMs", () => {
  it("pauses while suspended and backs off under host constraints", () => {
    expect(resolveNativeSampleIntervalMs({ ...basePower, suspended: true }, 1)).toBe(0);
    expect(resolveNativeSampleIntervalMs({ ...basePower, locked: "true" }, 1)).toBe(15_000);
    expect(resolveNativeSampleIntervalMs({ ...basePower, lowPowerMode: "true" }, 1)).toBe(15_000);
    expect(resolveNativeSampleIntervalMs({ ...basePower, thermalState: "critical" }, 1)).toBe(
      15_000,
    );
    expect(resolveNativeSampleIntervalMs({ ...basePower, onBattery: "true" }, 1)).toBe(5_000);
  });

  it("keeps unknown background telemetry cheap but serves live diagnostics at 1Hz", () => {
    const unknown: HostPowerSnapshot = {
      ...basePower,
      source: "unknown",
      stale: true,
    };
    expect(resolveNativeSampleIntervalMs(unknown, 0)).toBe(5_000);
    expect(resolveNativeSampleIntervalMs(unknown, 1)).toBe(1_000);
    expect(
      resolveNativeSampleIntervalMs(
        { ...basePower, stale: true, locked: "true", suspended: true },
        0,
      ),
    ).toBe(5_000);
    expect(resolveNativeSampleIntervalMs(basePower, 0)).toBe(1_000);
  });
});
