import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
  telemetrySettingLocks,
} from "./SettingsPanels.logic";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});

describe("telemetry setting locks", () => {
  const observability = (telemetryEnabledByEnvironment?: boolean) => ({
    logsDirectoryPath: "/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
    ...(telemetryEnabledByEnvironment === undefined ? {} : { telemetryEnabledByEnvironment }),
  });
  const policy = (telemetry: boolean) => ({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { telemetry },
  });

  it("leaves the setting in charge where neither a policy nor the variable decides", () => {
    expect(
      telemetrySettingLocks([
        { label: "Laptop", serverConfig: { observability: observability() } },
      ]),
    ).toEqual([]);
  });

  it("reports the variable's value with its environment", () => {
    expect(
      telemetrySettingLocks([
        { label: "Laptop", serverConfig: { observability: observability(false) } },
      ]),
    ).toEqual([
      { value: false, reason: "Set by T3CODE_TELEMETRY_ENABLED=false on Laptop.", managed: false },
    ]);
  });

  it("lets a policy that turns telemetry off win over the variable", () => {
    expect(
      telemetrySettingLocks([
        {
          label: "Laptop",
          serverConfig: { observability: observability(true), managedPolicy: policy(false) },
        },
      ]),
    ).toEqual([
      { value: false, reason: "Example Corp turned off anonymous usage data.", managed: true },
    ]);
  });

  it("ignores a policy that allows telemetry", () => {
    expect(
      telemetrySettingLocks([
        {
          label: "Laptop",
          serverConfig: { observability: observability(), managedPolicy: policy(true) },
        },
      ]),
    ).toEqual([]);
  });
});
