export type LinuxPasswordStorePreference =
  | "auto"
  | "gnome-libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6";
export type LinuxPasswordStoreSwitch = Exclude<LinuxPasswordStorePreference, "auto">;

export const DEFAULT_LINUX_PASSWORD_STORE: LinuxPasswordStorePreference = "auto";

// Chromium matches desktop names case-sensitively and stops at the first recognized value.
const ELECTRON_LIBSECRET_DESKTOPS = new Set([
  "Deepin",
  "GNOME",
  "Pantheon",
  "UKUI",
  "Unity",
  "X-Cinnamon",
  "XFCE",
]);
// Chromium selects a KWallet generation for KDE from KDE_SESSION_VERSION, so it needs no help.
const ELECTRON_KDE_DESKTOP = "KDE";
// Chromium recognizes LXQt and still selects basic text for it, so it does need a forced backend.
const ELECTRON_UNPROTECTED_DESKTOPS = new Set(["LXQt"]);

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

  return electronSelectsProtectedBackend(input.env) ? null : "gnome-libsecret";
}

// DESKTOP_SESSION and legacy KDE markers can be stale, so only trust exact XDG_CURRENT_DESKTOP values.

function electronSelectsProtectedBackend(env: NodeJS.ProcessEnv): boolean {
  for (const name of splitDesktopNameList(env.XDG_CURRENT_DESKTOP)) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed === ELECTRON_KDE_DESKTOP || ELECTRON_LIBSECRET_DESKTOPS.has(trimmed)) {
      return true;
    }
    if (ELECTRON_UNPROTECTED_DESKTOPS.has(trimmed)) {
      return false;
    }
  }

  return false;
}

function splitDesktopNameList(value: string | undefined): string[] {
  return value?.split(":") ?? [];
}
