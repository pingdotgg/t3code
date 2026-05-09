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
import { resolveDefaultLinuxDbusSessionBusAddress } from "../shell/DesktopShellEnvironment.ts";
import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly readFileString: (path: string) => string;
}

interface EarlyLinuxElectronOptionsInput extends EarlyDesktopSettingsInput {
  readonly exists: (path: string) => boolean;
  readonly uid: number | undefined;
}

export interface EarlyLinuxElectronOptions {
  readonly dbusSessionBusAddress: string | null;
  readonly linuxWmClass: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

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

const joinLinuxPath = (first: string, ...segments: string[]): string => {
  const normalizedFirst = first.replace(/\/+$/u, "");
  const normalizedSegments = segments.map((segment) => segment.replace(/^\/+|\/+$/gu, ""));
  if (first.length > 0 && normalizedFirst.length === 0 && first.startsWith("/")) {
    const normalizedPath = normalizedSegments.filter((segment) => segment.length > 0).join("/");
    return normalizedPath.length > 0 ? `/${normalizedPath}` : "/";
  }
  return [normalizedFirst, ...normalizedSegments].filter((segment) => segment.length > 0).join("/");
};

function resolveEarlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): string {
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: joinLinuxPath,
    t3Home: Option.fromUndefinedOr(input.env.T3CODE_HOME),
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDevelopmentEnvironment(input.env),
    joinPath: joinLinuxPath,
  });
  return joinLinuxPath(stateDir, "desktop-settings.json");
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

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  return {
    dbusSessionBusAddress:
      trimNonEmpty(input.env.DBUS_SESSION_BUS_ADDRESS) === null
        ? resolveDefaultLinuxDbusSessionBusAddress({
            env: input.env,
            exists: input.exists,
            uid: input.uid,
          })
        : null,
    linuxWmClass: isDevelopmentEnvironment(input.env) ? "t3code-dev" : "t3code",
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
