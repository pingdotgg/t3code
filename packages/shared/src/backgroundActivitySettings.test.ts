import { DEFAULT_SERVER_SETTINGS, MIN_PROVIDER_HEALTH_REFRESH_INTERVAL } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import {
  clampProviderHealthRefreshInterval,
  getBackgroundActivityPresetSettings,
  normalizeBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const MIN_MILLIS = Duration.toMillis(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL);

describe("clampProviderHealthRefreshInterval", () => {
  it("keeps zero as disabled", () => {
    expect(Duration.toMillis(clampProviderHealthRefreshInterval(Duration.zero))).toBe(0);
  });

  it("floors short intervals at the minimum", () => {
    expect(Duration.toMillis(clampProviderHealthRefreshInterval(Duration.seconds(5)))).toBe(
      MIN_MILLIS,
    );
    expect(Duration.toMillis(clampProviderHealthRefreshInterval(Duration.seconds(30)))).toBe(
      MIN_MILLIS,
    );
  });

  it("leaves intervals at or above the minimum alone", () => {
    expect(
      Duration.toMillis(clampProviderHealthRefreshInterval(MIN_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ).toBe(MIN_MILLIS);
    expect(Duration.toMillis(clampProviderHealthRefreshInterval(Duration.minutes(10)))).toBe(
      600_000,
    );
  });
});

describe("provider health refresh interval floor", () => {
  it("floors a custom override below the minimum", () => {
    const resolved = resolveBackgroundActivitySettings({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: { providerHealthRefreshInterval: Duration.seconds(5) },
    });
    expect(Duration.toMillis(resolved.providerHealthRefreshInterval)).toBe(MIN_MILLIS);
  });

  it("keeps a zero override disabled", () => {
    const resolved = resolveBackgroundActivitySettings({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: { providerHealthRefreshInterval: Duration.zero },
    });
    expect(Duration.toMillis(resolved.providerHealthRefreshInterval)).toBe(0);
  });

  it("floors a legacy flat setting below the minimum", () => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_SERVER_SETTINGS,
      providerHealthRefreshInterval: Duration.seconds(5),
    });
    expect(Duration.toMillis(resolved.providerHealthRefreshInterval)).toBe(MIN_MILLIS);
  });

  it("keeps every preset at or above the minimum", () => {
    for (const profile of ["performance", "balanced", "battery-saver"] as const) {
      const preset = getBackgroundActivityPresetSettings(profile);
      expect(Duration.toMillis(preset.providerHealthRefreshInterval)).toBeGreaterThanOrEqual(
        MIN_MILLIS,
      );
    }
  });

  it("still recognises the performance preset after resolving", () => {
    const normalized = normalizeBackgroundActivitySettings({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {},
    });
    expect(normalized).toEqual({ schemaVersion: 1, profile: "performance", overrides: {} });
  });
});
