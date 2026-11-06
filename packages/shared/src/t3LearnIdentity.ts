// OminaX installs next to T3 Code, so every name the OS or another app can
// see differs from T3 Code's: app id, data folder, link scheme and command.
// Development builds keep upstream's dev scheme, profile and window names.

export const T3_LEARN_REPOSITORY = "aabdel0181/ominax";
export const T3_LEARN_APP_ID = "io.github.aabdel0181.ominax";
export const T3_LEARN_PRODUCT_NAME = "OminaX";
/** Linux executable and WM class, deb package, Windows install folder and boot service, like upstream's `t3code`. */
export const T3_LEARN_EXECUTABLE_NAME = "ominax";
/** The CLI command Settings → About installs, like upstream's `t3`. */
export const T3_LEARN_COMMAND = "ominax";
/** The renderer's origin `t3learn://app`; its browser storage is filed under it, so it stays (D74). */
export const T3_LEARN_DESKTOP_SCHEME = "t3learn";
/** The scheme of links OminaX writes. Parsers accept it and `T3_LEARN_DESKTOP_SCHEME`. */
export const T3_LEARN_LINK_SCHEME = "ominax";
export const T3_LEARN_LINK_SCHEMES = [T3_LEARN_LINK_SCHEME, T3_LEARN_DESKTOP_SCHEME] as const;
export const T3_LEARN_LINUX_DESKTOP_ENTRY = "io.github.aabdel0181.OminaX.desktop";
export const T3_LEARN_HOME_DIRECTORY = ".ominax";
export const T3_LEARN_HOME_ENV = "OMINAX_HOME";
export const T3_LEARN_ELECTRON_USER_DATA = "ominax";
/** Tailscale Serve maps a port machine-wide; T3 Code defaults to 443. */
export const T3_LEARN_TAILSCALE_SERVE_PORT = 8443;

/** Names installs before the OminaX rename (REL-45) used; still accepted, found or migrated from. */
export const T3_LEARN_LEGACY = {
  appId: "io.github.aabdel0181.t3learn",
  executableName: "t3learn",
  command: "t3-learn",
  linuxDesktopEntry: "io.github.aabdel0181.T3Learn.desktop",
  homeDirectory: ".t3-learn",
  homeEnv: "T3LEARN_HOME",
  electronUserData: "t3learn",
} as const;
