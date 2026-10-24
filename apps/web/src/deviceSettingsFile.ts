import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ThemePreferenceMode } from "./themePalette";

/**
 * Whether each client setting goes in the device settings file. Settings that describe how someone
 * likes the client to behave are in. Values tied to one machine or to one environment's data stay
 * out: onboarding state, dismissed notices, browser profiles, the legacy model preferences and merge
 * overrides, and overrides keyed by project or environment id. A new client setting fails to
 * compile here until it is placed on one side.
 */
const DEVICE_SETTINGS_FILE_SCOPE = {
  notificationMode: true,
  inAppNotificationsEnabled: true,
  diffColorScheme: true,
  chatWidth: true,
  loadBalancingEnabled: true,
  appearanceContrast: true,
  panelAnimationDurationMs: true,
  browserDefaultViewport: true,
  browserDefaultZoomFactor: true,
  browserDefaultAppearance: true,
  browserRecordingFrameRate: true,
  browserRecordingShowKeyPresses: true,
  browserRecordingShowMousePresses: true,
  browserLinkTarget: true,
  browserSearchEngine: true,
  browserCustomSearchUrl: true,
  browserAutoShowFloatingPreview: true,
  confirmQuit: true,
  confirmThreadArchive: true,
  confirmThreadDelete: true,
  confirmThreadUnpin: true,
  diffFilesCollapsed: true,
  diffIgnoreWhitespace: true,
  diffLayout: true,
  environmentIdentificationMode: true,
  glassOpacity: true,
  fontSizeInterface: true,
  fontSizePrompt: true,
  fontSizeCode: true,
  fontSizeTerminal: true,
  fontFamilyCode: true,
  fontFamilyComposer: true,
  fontFamilySans: true,
  fontFamilyTerminal: true,
  fontSmoothing: true,
  persistComposerContextStrip: true,
  pullRequestLinksOpenInApp: true,
  planModeEnabled: true,
  contextWindowMeterEnabled: true,
  composerCollapseOnScroll: true,
  composerRichTextEnabled: true,
  sendShortcut: true,
  followUpBehavior: true,
  proactivePanelsEnabled: true,
  showSkillsInSlashMenu: true,
  legacySidebarEnabled: true,
  sidebarWorkingShelfEnabled: true,
  sidebarProjectGroupingMode: true,
  sidebarProjectSortOrder: true,
  sidebarThreadSortOrder: true,
  sidebarThreadPreviewCount: true,
  timestampFormat: true,
  snapShotEnabled: true,
  snapShotIncludeAccessibility: true,
  snapShotShortcut: true,
  snapShotPlaySound: true,
  snapShotSound: true,
  snapShotFlash: true,
  snapShotAnimations: true,
  wordWrap: true,
  mathRenderingEnabled: true,
  onboardingCompletedAt: false,
  dismissedProviderUpdateNotificationKeys: false,
  browserProfiles: false,
  browserDefaultProfileId: false,
  favorites: false,
  providerModelPreferences: false,
  pullRequestMergeMethodOverrides: false,
  sidebarProjectGroupingOverrides: false,
  loadBalancingWeights: false,
} as const satisfies Record<keyof ClientSettings, boolean>;

export type DeviceSettingKey = {
  [
    K in keyof typeof DEVICE_SETTINGS_FILE_SCOPE
  ]: (typeof DEVICE_SETTINGS_FILE_SCOPE)[K] extends true ? K : never;
}[keyof typeof DEVICE_SETTINGS_FILE_SCOPE];

const DEVICE_SETTINGS_FILE_KEYS = (
  Object.keys(DEVICE_SETTINGS_FILE_SCOPE) as Array<keyof typeof DEVICE_SETTINGS_FILE_SCOPE>
).filter((key): key is DeviceSettingKey => DEVICE_SETTINGS_FILE_SCOPE[key]);

export type DeviceSettings = Pick<ClientSettings, DeviceSettingKey>;

/** The theme used for each half of the system mode; null means that half has none. */
export interface ThemePair {
  readonly light: string | null;
  readonly dark: string | null;
}

export interface DeviceAppearance {
  readonly theme: string;
  readonly appearanceMode: ThemePreferenceMode;
  readonly themeHalves: ThemePair;
  readonly advancedTypography: boolean;
}

export interface DeviceSettingsSnapshot {
  readonly settings: DeviceSettings;
  readonly appearance: DeviceAppearance;
}

/** Only the values a file sets validly; everything else keeps its current value on import. */
export interface DeviceSettingsFileImport {
  readonly settings: Partial<DeviceSettings>;
  readonly appearance: {
    readonly theme?: string;
    readonly appearanceMode?: ThemePreferenceMode;
    readonly themeHalves?: Partial<ThemePair>;
    readonly advancedTypography?: boolean;
  };
  readonly warnings: ReadonlyArray<string>;
}

export interface DeviceSettingChange {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
}

const DEVICE_SETTING_KEY_SET: ReadonlySet<string> = new Set(DEVICE_SETTINGS_FILE_KEYS);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

/** One decoder per device setting, so each value is checked against its own field schema. */
const DEVICE_SETTING_DECODERS = Object.fromEntries(
  DEVICE_SETTINGS_FILE_KEYS.map((key) => [
    key,
    Schema.decodeUnknownOption(ClientSettingsSchema.fields[key] as Schema.Codec<unknown>),
  ]),
) as Record<DeviceSettingKey, (rawValue: unknown) => Option.Option<unknown>>;

function isDeviceSettingKey(key: string): key is DeviceSettingKey {
  return DEVICE_SETTING_KEY_SET.has(key);
}

export function pickDeviceSettings(settings: ClientSettings): DeviceSettings {
  return Object.fromEntries(
    DEVICE_SETTINGS_FILE_KEYS.map((key) => [key, settings[key]]),
  ) as DeviceSettings;
}

/** Every value is written, so importing the file makes another browser match this one. */
export function serializeDeviceSettingsFile(input: {
  readonly settings: ClientSettings;
  readonly appearance: DeviceAppearance;
}): string {
  const encoded: Readonly<Record<string, unknown>> = encodeClientSettings(input.settings);
  const file: Record<string, unknown> = {};
  for (const key of DEVICE_SETTINGS_FILE_KEYS) file[key] = encoded[key];
  file.theme = input.appearance.theme;
  file.appearanceMode = input.appearance.appearanceMode;
  file.themeHalves = input.appearance.themeHalves;
  file.advancedTypography = input.appearance.advancedTypography;
  return `${JSON.stringify(file, null, 2)}\n`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemePreferenceMode(value: unknown): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

const invalidValue = (key: string) => `${key}: invalid value, kept the current one`;

/**
 * Import merges: each value that passes its check replaces the current one, and every other
 * value stays as it is. Unknown keys and invalid values become warnings instead of failing the
 * file, so a file written by another version still applies everything it can.
 */
export function parseDeviceSettingsFile(
  value: unknown,
  isKnownTheme: (themeId: string) => boolean,
): DeviceSettingsFileImport {
  if (!isRecord(value)) {
    throw new Error("Device settings files must contain a JSON object.");
  }

  const warnings: string[] = [];
  const settings: Record<string, unknown> = {};
  const appearance: {
    theme?: string;
    appearanceMode?: ThemePreferenceMode;
    themeHalves?: Partial<ThemePair>;
    advancedTypography?: boolean;
  } = {};
  const isTheme = (themeId: unknown): themeId is string =>
    typeof themeId === "string" && isKnownTheme(themeId);

  for (const [key, rawValue] of Object.entries(value)) {
    if (key === "theme") {
      if (isTheme(rawValue)) appearance.theme = rawValue;
      else warnings.push(invalidValue(key));
    } else if (key === "appearanceMode") {
      if (isThemePreferenceMode(rawValue)) appearance.appearanceMode = rawValue;
      else warnings.push(invalidValue(key));
    } else if (key === "advancedTypography") {
      if (typeof rawValue === "boolean") appearance.advancedTypography = rawValue;
      else warnings.push(invalidValue(key));
    } else if (key === "themeHalves") {
      if (!isRecord(rawValue)) {
        warnings.push(invalidValue(key));
        continue;
      }
      const themeHalves: { light?: string | null; dark?: string | null } = {};
      for (const half of ["light", "dark"] as const) {
        if (!(half in rawValue)) continue;
        const themeId = rawValue[half];
        if (themeId === null || isTheme(themeId)) themeHalves[half] = themeId;
        else warnings.push(invalidValue(`themeHalves.${half}`));
      }
      appearance.themeHalves = themeHalves;
    } else if (!isDeviceSettingKey(key)) {
      warnings.push(`${key}: not a device setting, ignored`);
    } else {
      const decoded = DEVICE_SETTING_DECODERS[key](rawValue);
      if (Option.isSome(decoded)) settings[key] = decoded.value;
      else warnings.push(invalidValue(key));
    }
  }

  return { settings: settings as Partial<DeviceSettings>, appearance, warnings };
}

export function mergeDeviceSettings(
  current: DeviceSettingsSnapshot,
  imported: DeviceSettingsFileImport,
): DeviceSettingsSnapshot {
  const { themeHalves, ...appearance } = imported.appearance;
  return {
    settings: { ...current.settings, ...imported.settings },
    appearance: {
      ...current.appearance,
      ...appearance,
      themeHalves: { ...current.appearance.themeHalves, ...themeHalves },
    },
  };
}

export function diffDeviceSettings(
  current: DeviceSettingsSnapshot,
  next: DeviceSettingsSnapshot,
): ReadonlyArray<DeviceSettingChange> {
  const changes: DeviceSettingChange[] = [];
  const compare = (key: string, from: unknown, to: unknown) => {
    if (!Equal.equals(from, to)) changes.push({ key, from, to });
  };
  for (const key of DEVICE_SETTINGS_FILE_KEYS) {
    compare(key, current.settings[key], next.settings[key]);
  }
  compare("theme", current.appearance.theme, next.appearance.theme);
  compare("appearanceMode", current.appearance.appearanceMode, next.appearance.appearanceMode);
  for (const half of ["light", "dark"] as const) {
    compare(
      `themeHalves.${half}`,
      current.appearance.themeHalves[half],
      next.appearance.themeHalves[half],
    );
  }
  compare(
    "advancedTypography",
    current.appearance.advancedTypography,
    next.appearance.advancedTypography,
  );
  return changes;
}
