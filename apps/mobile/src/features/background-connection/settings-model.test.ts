import { describe, expect, it } from "vite-plus/test";

import type { BackgroundConnectionStatus } from "../../native/backgroundConnection";
import {
  backgroundConnectionStatusLabel,
  shouldRequestBackgroundConnectionBatteryExemption,
} from "./settings-model";

const status = (overrides: Partial<BackgroundConnectionStatus>): BackgroundConnectionStatus => ({
  supported: true,
  enabled: true,
  serviceRunning: true,
  runtimeReady: true,
  batteryOptimizationIgnored: true,
  ...overrides,
});

describe("backgroundConnectionStatusLabel", () => {
  it("reports the fully ready runtime", () => {
    expect(backgroundConnectionStatusLabel(status({}))).toBe("Running");
  });

  it("reports startup until both native service and JavaScript are ready", () => {
    expect(backgroundConnectionStatusLabel(status({ runtimeReady: false }))).toBe("Starting");
    expect(backgroundConnectionStatusLabel(status({ serviceRunning: false }))).toBe("Starting");
  });

  it("makes degraded battery protection explicit", () => {
    expect(backgroundConnectionStatusLabel(status({ batteryOptimizationIgnored: false }))).toBe(
      "Battery optimization enabled",
    );
  });

  it("reports disabled and unsupported installations as stopped", () => {
    expect(backgroundConnectionStatusLabel(status({ enabled: false }))).toBe("Stopped");
    expect(backgroundConnectionStatusLabel(status({ supported: false }))).toBe("Stopped");
  });

  it("keeps the feature enabled when the battery exemption is still declined", () => {
    const declined = status({ batteryOptimizationIgnored: false });
    expect(shouldRequestBackgroundConnectionBatteryExemption(declined)).toBe(true);
    expect(declined.enabled).toBe(true);
  });

  it("does not request an exemption while disabling", () => {
    expect(
      shouldRequestBackgroundConnectionBatteryExemption(
        status({ enabled: false, batteryOptimizationIgnored: false }),
      ),
    ).toBe(false);
  });
});
