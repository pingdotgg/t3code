export type LinuxPasswordStorePreference =
  | "auto"
  | "gnome-libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6";
export type LinuxPasswordStoreSwitch = Exclude<LinuxPasswordStorePreference, "auto">;

export const DEFAULT_LINUX_PASSWORD_STORE: LinuxPasswordStorePreference = "auto";

const ELECTRON_LIBSECRET_DESKTOPS = new Set([
  "deepin",
  "gnome",
  "pantheon",
  "ukui",
  "unity",
  "x-cinnamon",
  "xfce",
]);

const ELECTRON_KWALLET_DESKTOPS = new Set(["kde4", "kde5", "kde6"]);
const KDE_DESKTOPS = new Set(["kde", "kde4", "kde5", "kde6", "plasma"]);

export function normalizeLinuxPasswordStorePreference(
  value: unknown,
): LinuxPasswordStorePreference {
  return value === "gnome-libsecret" ||
    value === "kwallet" ||
    value === "kwallet5" ||
    value === "kwallet6"
    ? value
    : DEFAULT_LINUX_PASSWORD_STORE;
}

export function resolveLinuxPasswordStoreSwitch(input: {
  readonly preference: LinuxPasswordStorePreference;
  readonly env: NodeJS.ProcessEnv;
}): LinuxPasswordStoreSwitch | null {
  if (input.preference !== "auto") {
    return input.preference;
  }

  if (isElectronKnownLinuxSecretStorageDesktop(input.env)) {
    return null;
  }

  return isKdeDesktop(input.env) ? "kwallet" : "gnome-libsecret";
}

export function resolveLinuxSecretStorageUnavailableMessage(input: {
  readonly configuredPreference: LinuxPasswordStorePreference;
  readonly selectedBackend: string | null;
  readonly env: NodeJS.ProcessEnv;
}): string {
  if (input.configuredPreference === "gnome-libsecret") {
    return getGnomeKeyringRemediationMessage();
  }

  if (
    input.configuredPreference === "kwallet" ||
    input.configuredPreference === "kwallet5" ||
    input.configuredPreference === "kwallet6"
  ) {
    return getKWalletRemediationMessage();
  }

  const backend = normalizeSelectedStorageBackend(input.selectedBackend);
  if (backend === "gnome-libsecret") {
    return getGnomeKeyringRemediationMessage();
  }

  if (
    backend === "kwallet" ||
    backend === "kwallet5" ||
    backend === "kwallet6" ||
    isKdeDesktop(input.env)
  ) {
    return getKWalletRemediationMessage();
  }

  return getGnomeKeyringRemediationMessage();
}

function getGnomeKeyringRemediationMessage(): string {
  return "T3 Code could not access GNOME Keyring to save this environment credential. Install and start GNOME Keyring, then restart T3 Code.";
}

function getKWalletRemediationMessage(): string {
  return "T3 Code could not access KWallet to save this environment credential. Enable the KDE wallet subsystem in System Settings, then restart T3 Code.";
}

function isElectronKnownLinuxSecretStorageDesktop(env: NodeJS.ProcessEnv): boolean {
  return resolveAuthoritativeLinuxDesktopNames(env).some(
    (name) => ELECTRON_LIBSECRET_DESKTOPS.has(name) || ELECTRON_KWALLET_DESKTOPS.has(name),
  );
}

function isKdeDesktop(env: NodeJS.ProcessEnv): boolean {
  return resolveAuthoritativeLinuxDesktopNames(env).some((name) => KDE_DESKTOPS.has(name));
}

function resolveAuthoritativeLinuxDesktopNames(env: NodeJS.ProcessEnv): string[] {
  const authoritative = [
    ...splitDesktopNameList(env.XDG_CURRENT_DESKTOP),
    env.XDG_SESSION_DESKTOP,
    env.KDE_SESSION_VERSION ? `kde${env.KDE_SESSION_VERSION}` : undefined,
  ].flatMap((entry) => {
    const normalized = normalizeDesktopName(entry);
    return normalized ? [normalized] : [];
  });
  return authoritative.length > 0 ? authoritative : resolveLinuxDesktopNames(env);
}

function resolveLinuxDesktopNames(env: NodeJS.ProcessEnv): string[] {
  return [
    ...splitDesktopNameList(env.XDG_CURRENT_DESKTOP),
    env.XDG_SESSION_DESKTOP,
    env.DESKTOP_SESSION,
    env.GDMSESSION,
    env.KDE_SESSION_VERSION ? `kde${env.KDE_SESSION_VERSION}` : undefined,
  ].flatMap((entry) => {
    const normalized = normalizeDesktopName(entry);
    return normalized ? [normalized] : [];
  });
}

function splitDesktopNameList(value: string | undefined): string[] {
  return value?.split(":") ?? [];
}

function normalizeDesktopName(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeSelectedStorageBackend(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase().replace(/_/gu, "-");
  return normalized && normalized.length > 0 ? normalized : null;
}
