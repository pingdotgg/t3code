import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  isGamescopeDesktop,
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
  readonly fileExists?: (path: string) => boolean;
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

const resolveDataHome = (input: EarlyDesktopSettingsInput): string => {
  const configured = trimNonEmpty(input.env.XDG_DATA_HOME);
  return configured?.startsWith("/")
    ? configured
    : input.joinPath(input.homeDirectory, ".local", "share");
};

function hasDbusService(input: EarlyDesktopSettingsInput, name: string): boolean {
  const dataDirs = (
    trimNonEmpty(input.env.XDG_DATA_DIRS)?.split(":") ?? ["/usr/local/share", "/usr/share"]
  ).filter((directory) => directory.startsWith("/"));
  for (const directory of [resolveDataHome(input), ...dataDirs]) {
    try {
      const service = input.readFileString(
        input.joinPath(directory, "dbus-1", "services", `${name}.service`),
      );
      if (service.split(/\r?\n/).some((line) => line.trim() === `Name=${name}`)) {
        return true;
      }
    } catch {
      // A missing service file is normal on desktops using the other keyring.
    }
  }
  return false;
}

function gamescopeHasKwallet6(input: EarlyDesktopSettingsInput): boolean {
  if (!hasDbusService(input, "org.kde.kwalletd6")) {
    return false;
  }
  // When both keyrings are installed, an existing wallet identifies the one
  // this account uses. A GNOME keyring advertised by the session takes priority.
  if (trimNonEmpty(input.env.GNOME_KEYRING_CONTROL) !== null) {
    return false;
  }
  const walletPath = input.joinPath(resolveDataHome(input), "kwalletd", "kdewallet.kwl");
  return (
    input.fileExists?.(walletPath) === true || !hasDbusService(input, "org.freedesktop.secrets")
  );
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
      gamescopeKwallet6Available:
        preference === "auto" && isGamescopeDesktop(input.env.XDG_CURRENT_DESKTOP)
          ? gamescopeHasKwallet6(input)
          : false,
    }),
  };
}
