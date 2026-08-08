import {
  type BackgroundActivityProfile,
  type BackgroundActivitySettings,
  DEFAULT_BACKGROUND_ACTIVITY_SETTINGS,
  DEFAULT_BACKGROUND_ACTIVITY_PROFILE,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  DEFAULT_SOURCE_CONTROL_ALL_REMOTES_FETCH_INTERVAL,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";

export interface ResolvedBackgroundActivitySettings {
  readonly profile: BackgroundActivityProfile;
  readonly automaticGitFetchInterval: Duration.Duration;
  readonly sourceControlAllRemotesFetchInterval: Duration.Duration;
  readonly providerHealthRefreshInterval: Duration.Duration;
  readonly hostPowerMonitorActiveInterval: Duration.Duration;
  readonly hostPowerMonitorIdleInterval: Duration.Duration;
  readonly idleClientTtl: Duration.Duration;
  readonly pauseWhenHostLocked: boolean;
  readonly pauseWhenHostLowPower: boolean;
  readonly pauseWhenClientLowPower: boolean;
  readonly pauseWhenOnBattery: boolean;
}

const PRESET_SETTINGS: Record<BackgroundActivityProfile, ResolvedBackgroundActivitySettings> = {
  performance: {
    profile: "performance",
    automaticGitFetchInterval: Duration.seconds(15),
    sourceControlAllRemotesFetchInterval: Duration.minutes(1),
    providerHealthRefreshInterval: Duration.minutes(1),
    hostPowerMonitorActiveInterval: Duration.seconds(30),
    hostPowerMonitorIdleInterval: Duration.minutes(2),
    idleClientTtl: Duration.seconds(45),
    pauseWhenHostLocked: true,
    pauseWhenHostLowPower: false,
    pauseWhenClientLowPower: false,
    pauseWhenOnBattery: false,
  },
  balanced: {
    profile: "balanced",
    automaticGitFetchInterval: DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
    sourceControlAllRemotesFetchInterval: DEFAULT_SOURCE_CONTROL_ALL_REMOTES_FETCH_INTERVAL,
    providerHealthRefreshInterval: DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
    hostPowerMonitorActiveInterval: Duration.seconds(30),
    hostPowerMonitorIdleInterval: Duration.minutes(5),
    idleClientTtl: Duration.seconds(45),
    pauseWhenHostLocked: true,
    pauseWhenHostLowPower: true,
    pauseWhenClientLowPower: true,
    pauseWhenOnBattery: false,
  },
  "battery-saver": {
    profile: "battery-saver",
    automaticGitFetchInterval: Duration.seconds(0),
    sourceControlAllRemotesFetchInterval: Duration.seconds(0),
    providerHealthRefreshInterval: Duration.minutes(15),
    hostPowerMonitorActiveInterval: Duration.minutes(1),
    hostPowerMonitorIdleInterval: Duration.minutes(10),
    idleClientTtl: Duration.seconds(45),
    pauseWhenHostLocked: true,
    pauseWhenHostLowPower: true,
    pauseWhenClientLowPower: true,
    pauseWhenOnBattery: true,
  },
};

export function getBackgroundActivityPresetSettings(
  profile: BackgroundActivityProfile,
): ResolvedBackgroundActivitySettings {
  return PRESET_SETTINGS[profile];
}

export function getBackgroundActivityBaseProfile(
  backgroundActivity: BackgroundActivitySettings,
): BackgroundActivityProfile {
  if (backgroundActivity.profile === "custom") {
    return backgroundActivity.baseProfile ?? DEFAULT_BACKGROUND_ACTIVITY_PROFILE;
  }
  return backgroundActivity.profile;
}

export function resolveBackgroundActivitySettings(
  backgroundActivity: BackgroundActivitySettings,
): ResolvedBackgroundActivitySettings {
  const baseProfile = getBackgroundActivityBaseProfile(backgroundActivity);
  const preset = PRESET_SETTINGS[baseProfile];
  const overrides = backgroundActivity.profile === "custom" ? backgroundActivity.overrides : {};
  return {
    profile: baseProfile,
    automaticGitFetchInterval:
      overrides.automaticGitFetchInterval ?? preset.automaticGitFetchInterval,
    sourceControlAllRemotesFetchInterval:
      overrides.sourceControlAllRemotesFetchInterval ?? preset.sourceControlAllRemotesFetchInterval,
    providerHealthRefreshInterval:
      overrides.providerHealthRefreshInterval ?? preset.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval:
      overrides.hostPowerMonitorActiveInterval ?? preset.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval:
      overrides.hostPowerMonitorIdleInterval ?? preset.hostPowerMonitorIdleInterval,
    idleClientTtl: overrides.idleClientTtl ?? preset.idleClientTtl,
    pauseWhenHostLocked: overrides.pauseWhenHostLocked ?? preset.pauseWhenHostLocked,
    pauseWhenHostLowPower: overrides.pauseWhenHostLowPower ?? preset.pauseWhenHostLowPower,
    pauseWhenClientLowPower: overrides.pauseWhenClientLowPower ?? preset.pauseWhenClientLowPower,
    pauseWhenOnBattery: overrides.pauseWhenOnBattery ?? preset.pauseWhenOnBattery,
  };
}

function durationsEqual(a: Duration.Duration, b: Duration.Duration): boolean {
  return Duration.toMillis(a) === Duration.toMillis(b);
}

function isDefaultBackgroundActivitySettings(
  backgroundActivity: BackgroundActivitySettings,
): boolean {
  return (
    backgroundActivity.profile === DEFAULT_BACKGROUND_ACTIVITY_SETTINGS.profile &&
    backgroundActivity.baseProfile === DEFAULT_BACKGROUND_ACTIVITY_SETTINGS.baseProfile &&
    Object.keys(backgroundActivity.overrides).length === 0
  );
}

function resolvedSettingsEqual(
  a: ResolvedBackgroundActivitySettings,
  b: ResolvedBackgroundActivitySettings,
): boolean {
  return (
    durationsEqual(a.automaticGitFetchInterval, b.automaticGitFetchInterval) &&
    durationsEqual(
      a.sourceControlAllRemotesFetchInterval,
      b.sourceControlAllRemotesFetchInterval,
    ) &&
    durationsEqual(a.providerHealthRefreshInterval, b.providerHealthRefreshInterval) &&
    durationsEqual(a.hostPowerMonitorActiveInterval, b.hostPowerMonitorActiveInterval) &&
    durationsEqual(a.hostPowerMonitorIdleInterval, b.hostPowerMonitorIdleInterval) &&
    durationsEqual(a.idleClientTtl, b.idleClientTtl) &&
    a.pauseWhenHostLocked === b.pauseWhenHostLocked &&
    a.pauseWhenHostLowPower === b.pauseWhenHostLowPower &&
    a.pauseWhenClientLowPower === b.pauseWhenClientLowPower &&
    a.pauseWhenOnBattery === b.pauseWhenOnBattery
  );
}

export function normalizeBackgroundActivitySettings(
  backgroundActivity: BackgroundActivitySettings,
): BackgroundActivitySettings {
  if (backgroundActivity.profile !== "custom") {
    return {
      schemaVersion: 1,
      profile: backgroundActivity.profile,
      overrides: {},
    };
  }

  const resolved = resolveBackgroundActivitySettings(backgroundActivity);
  const profiles: ReadonlyArray<BackgroundActivityProfile> = [
    getBackgroundActivityBaseProfile(backgroundActivity),
    "balanced",
    "performance",
    "battery-saver",
  ];
  for (const profile of profiles) {
    if (resolvedSettingsEqual(resolved, PRESET_SETTINGS[profile])) {
      return {
        schemaVersion: 1,
        profile,
        overrides: {},
      };
    }
  }

  const baseProfile = getBackgroundActivityBaseProfile(backgroundActivity);
  const preset = PRESET_SETTINGS[baseProfile];
  const overrides: BackgroundActivitySettings["overrides"] = {
    ...(!durationsEqual(resolved.automaticGitFetchInterval, preset.automaticGitFetchInterval)
      ? { automaticGitFetchInterval: resolved.automaticGitFetchInterval }
      : {}),
    ...(!durationsEqual(
      resolved.sourceControlAllRemotesFetchInterval,
      preset.sourceControlAllRemotesFetchInterval,
    )
      ? { sourceControlAllRemotesFetchInterval: resolved.sourceControlAllRemotesFetchInterval }
      : {}),
    ...(!durationsEqual(
      resolved.providerHealthRefreshInterval,
      preset.providerHealthRefreshInterval,
    )
      ? { providerHealthRefreshInterval: resolved.providerHealthRefreshInterval }
      : {}),
    ...(!durationsEqual(
      resolved.hostPowerMonitorActiveInterval,
      preset.hostPowerMonitorActiveInterval,
    )
      ? { hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval }
      : {}),
    ...(!durationsEqual(resolved.hostPowerMonitorIdleInterval, preset.hostPowerMonitorIdleInterval)
      ? { hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval }
      : {}),
    ...(!durationsEqual(resolved.idleClientTtl, preset.idleClientTtl)
      ? { idleClientTtl: resolved.idleClientTtl }
      : {}),
    ...(resolved.pauseWhenHostLocked !== preset.pauseWhenHostLocked
      ? { pauseWhenHostLocked: resolved.pauseWhenHostLocked }
      : {}),
    ...(resolved.pauseWhenHostLowPower !== preset.pauseWhenHostLowPower
      ? { pauseWhenHostLowPower: resolved.pauseWhenHostLowPower }
      : {}),
    ...(resolved.pauseWhenClientLowPower !== preset.pauseWhenClientLowPower
      ? { pauseWhenClientLowPower: resolved.pauseWhenClientLowPower }
      : {}),
    ...(resolved.pauseWhenOnBattery !== preset.pauseWhenOnBattery
      ? { pauseWhenOnBattery: resolved.pauseWhenOnBattery }
      : {}),
  };

  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile,
    overrides,
  };
}

export function resolveServerBackgroundActivitySettings(
  settings: ServerSettings,
): ResolvedBackgroundActivitySettings {
  const backgroundActivityIsDefault = isDefaultBackgroundActivitySettings(
    settings.backgroundActivity,
  );
  const legacyProfile = settings.backgroundActivityProfile;
  const hasLegacyOverrides =
    legacyProfile !== DEFAULT_BACKGROUND_ACTIVITY_PROFILE ||
    Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) ||
    Duration.toMillis(settings.providerHealthRefreshInterval) !==
      Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL);
  if (backgroundActivityIsDefault && hasLegacyOverrides) {
    return resolveBackgroundActivitySettings({
      schemaVersion: 1,
      profile:
        Duration.toMillis(settings.automaticGitFetchInterval) ===
          Duration.toMillis(
            getBackgroundActivityPresetSettings(legacyProfile).automaticGitFetchInterval,
          ) &&
        Duration.toMillis(settings.providerHealthRefreshInterval) ===
          Duration.toMillis(
            getBackgroundActivityPresetSettings(legacyProfile).providerHealthRefreshInterval,
          )
          ? legacyProfile
          : "custom",
      baseProfile: legacyProfile,
      overrides: {
        ...(Duration.toMillis(settings.automaticGitFetchInterval) !==
        Duration.toMillis(
          getBackgroundActivityPresetSettings(legacyProfile).automaticGitFetchInterval,
        )
          ? { automaticGitFetchInterval: settings.automaticGitFetchInterval }
          : {}),
        ...(Duration.toMillis(settings.providerHealthRefreshInterval) !==
        Duration.toMillis(
          getBackgroundActivityPresetSettings(legacyProfile).providerHealthRefreshInterval,
        )
          ? { providerHealthRefreshInterval: settings.providerHealthRefreshInterval }
          : {}),
      },
    });
  }
  return resolveBackgroundActivitySettings(settings.backgroundActivity);
}

export function normalizeServerBackgroundActivitySettings(
  settings: ServerSettings,
): BackgroundActivitySettings {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  return normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      sourceControlAllRemotesFetchInterval: resolved.sourceControlAllRemotesFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      idleClientTtl: resolved.idleClientTtl,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
}
