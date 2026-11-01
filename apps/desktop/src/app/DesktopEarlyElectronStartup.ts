import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly isDevelopment: boolean;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

export const resolveLinuxDesktopEntryName = (isDevelopment: boolean): string =>
  isDevelopment ? "com.t3tools.T3Code.Development.desktop" : "com.t3tools.T3Code.desktop";

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

function resolveEarlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
}): string {
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDevelopmentEnvironment(input.env),
    joinPath: input.joinPath,
    t3Home,
  });
  return input.joinPath(stateDir, "desktop-settings.json");
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  const settingsPath = resolveEarlyDesktopSettingsPath(input);
  try {
    const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
    return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
  } catch {
    return DEFAULT_LINUX_PASSWORD_STORE;
  }
}

const WAYLAND_COLOR_MANAGER_FEATURE = "WaylandWpColorManagerV1";

const featureListNames = (value: string | null): ReadonlyArray<string> =>
  (value ?? "").split(",").flatMap((entry) => entry.trim().match(/^\*?([^<:]+)/)?.[1] ?? []);

// HYPRLAND_INSTANCE_SIGNATURE can be stale; trust only the session's desktop names.
const isHyprlandSession = (env: NodeJS.ProcessEnv): boolean =>
  (trimNonEmpty(env.XDG_CURRENT_DESKTOP) ?? trimNonEmpty(env.XDG_SESSION_DESKTOP) ?? "")
    .split(":")
    .some((name) => name.trim().toLowerCase() === "hyprland");

const HyprctlVersionJson = fromLenientJson(
  Schema.Struct({
    version: Schema.String,
    tag: Schema.String,
    commit: Schema.String,
    dirty: Schema.Boolean,
  }),
);
const decodeHyprctlVersionJson = Schema.decodeSync(HyprctlVersionJson);

// Hyprland 0.48.0 rejects advertised set_primaries (hyprwm/Hyprland#9444); 0.51.0 accepts it (hyprwm/Hyprland#11499).
// Check commits because dev and Nix builds can retain release versions and tags.
const AFFECTED_HYPRLAND_RELEASE_COMMITS: ReadonlyMap<string, string> = new Map([
  ["0.48.0", "5ee35f914f921e5696030698e74fb5566a804768"],
  ["0.48.1", "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc"],
  ["0.49.0", "9958d297641b5c84dcff93f9039d80a5ad37ab00"],
  ["0.50.0", "c4a4c341568944bd4fb9cd503558b2de602c0213"],
  ["0.50.1", "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc"],
]);

const hasBrokenColorManager = (readHyprctlVersionJson: () => string): boolean => {
  try {
    const { version, tag, commit, dirty } = decodeHyprctlVersionJson(readHyprctlVersionJson());
    return (
      AFFECTED_HYPRLAND_RELEASE_COMMITS.get(version) === commit && tag === `v${version}` && !dirty
    );
  } catch {
    return false;
  }
};

export function resolveLinuxDisableFeaturesSwitch(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly ozonePlatform: string | null;
  readonly enableFeatures: string | null;
  readonly disableFeatures: string | null;
  readonly readHyprctlVersionJson: () => string;
}): string | null {
  if (input.ozonePlatform !== "wayland" || !isHyprlandSession(input.env)) return null;
  if (featureListNames(input.enableFeatures).includes(WAYLAND_COLOR_MANAGER_FEATURE)) return null;
  if (featureListNames(input.disableFeatures).includes(WAYLAND_COLOR_MANAGER_FEATURE)) return null;
  if (!hasBrokenColorManager(input.readHyprctlVersionJson)) return null;
  return input.disableFeatures === null
    ? WAYLAND_COLOR_MANAGER_FEATURE
    : `${input.disableFeatures},${WAYLAND_COLOR_MANAGER_FEATURE}`;
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const isDevelopment = isDevelopmentEnvironment(input.env);
  return {
    isDevelopment,
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(isDevelopment),
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}

/** Remember the explicit Chromium scale across AppImage updates, which drop launch arguments. */
export function restoreEarlyLinuxDeviceScaleFactor(
  input: EarlyDesktopSettingsInput & {
    readonly commandLine: {
      readonly hasSwitch: (name: string) => boolean;
      readonly getSwitchValue: (name: string) => string;
      readonly appendSwitch: (name: string, value: string) => void;
    };
    readonly writeFileString: (path: string, value: string) => void;
  },
): void {
  // Keep this separate from desktop-settings.json: the settings service rewrites
  // that document, and Chromium needs the value before that service is available.
  const path = input.joinPath(
    resolveEarlyDesktopSettingsPath(input),
    "..",
    "linux-device-scale-factor",
  );
  const switchName = "force-device-scale-factor";
  const isValid = (value: string) =>
    value.trim().length > 0 && Number.isFinite(Number(value)) && Number(value) > 0;
  if (input.commandLine.hasSwitch(switchName)) {
    const value = input.commandLine.getSwitchValue(switchName);
    if (isValid(value)) {
      try {
        input.writeFileString(path, value);
      } catch {
        // A read-only state directory must not prevent startup with the explicit switch.
      }
    }
    return;
  }
  try {
    const value = input.readFileString(path).trim();
    if (isValid(value)) input.commandLine.appendSwitch(switchName, value);
  } catch {
    // First launch, missing state, or unreadable state: keep Chromium's default.
  }
}
