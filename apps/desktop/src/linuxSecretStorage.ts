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
const SECRET_SERVICE_BUS_NAME = "org.freedesktop.secrets";
const KWALLET_BACKENDS = [
  { backend: "kwallet6", busName: "org.kde.kwalletd6" },
  { backend: "kwallet5", busName: "org.kde.kwalletd5" },
] as const satisfies ReadonlyArray<{ backend: LinuxPasswordStoreSwitch; busName: string }>;

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

export interface LinuxSessionBus {
  /** Running and activatable names; throws when the bus cannot be queried. */
  readonly listNames: () => ReadonlyArray<string>;
  /** Unique name of the connection owning `name`, or null when nothing runs under it. */
  readonly getNameOwner: (name: string) => string | null;
}

export function resolveLinuxPasswordStoreSwitch(input: {
  readonly preference: LinuxPasswordStorePreference;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionBus: LinuxSessionBus;
  /** Whether secrets saved under the previous auto choice (gnome-libsecret) are on disk. */
  readonly hasSavedSecrets: () => boolean;
}): LinuxPasswordStoreSwitch | null {
  if (input.preference !== "auto") {
    return input.preference;
  }

  return electronSelectsProtectedBackend(input.env)
    ? null
    : resolveForcedBackend(input.sessionBus, input.hasSavedSecrets);
}

// KWallet also serves the Secret Service API, but Chromium's libsecret backend fails against it.
function resolveForcedBackend(
  bus: LinuxSessionBus,
  hasSavedSecrets: () => boolean,
): LinuxPasswordStoreSwitch {
  let names: ReadonlySet<string>;
  try {
    names = new Set(bus.listNames());
  } catch {
    return "gnome-libsecret";
  }
  const wallets = KWALLET_BACKENDS.filter(({ busName }) => names.has(busName));
  const [firstWallet] = wallets;
  if (firstWallet === undefined) return "gnome-libsecret";
  if (!names.has(SECRET_SERVICE_BUS_NAME)) return firstWallet.backend;
  // An activatable Secret Service may be another keyring, and starting it to find out can hang.
  const secretServiceOwner = bus.getNameOwner(SECRET_SERVICE_BUS_NAME);
  if (secretServiceOwner === null) return "gnome-libsecret";
  // Saved secrets mean libsecret worked through this wallet; switching would orphan their key.
  if (hasSavedSecrets()) return "gnome-libsecret";
  return (
    wallets.find(({ busName }) => bus.getNameOwner(busName) === secretServiceOwner)?.backend ??
    "gnome-libsecret"
  );
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

/** Strings in `dbus-send --print-reply` output, such as the names from ListNames. */
export function parseDbusSendStrings(output: string): string[] {
  return Array.from(output.matchAll(/string "([^"]*)"/g), (match) => match[1] ?? "");
}
