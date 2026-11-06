// T3 Learn installs next to T3 Code, so every name the OS or another app can
// see differs from T3 Code's: app id, data folder, link scheme and command.
// Development builds keep upstream's dev scheme, profile and window names.

export const T3_LEARN_REPOSITORY = "aabdel0181/ominax";
export const T3_LEARN_APP_ID = "io.github.aabdel0181.ominax";
export const T3_LEARN_PRODUCT_NAME = "OminaX";
/** Linux executable and WM class, deb package, Windows install folder and boot service, like upstream's `t3code`. */
export const T3_LEARN_EXECUTABLE_NAME = "ominax";
/** The CLI command Settings → About installs, like upstream's `t3`. */
export const T3_LEARN_COMMAND = "ominax";
export const T3_LEARN_DESKTOP_SCHEME = "ominax";
/** The renderer's origin (`t3learn://app`) keys all browser-side storage, so it never moves (D74). */
export const T3_LEARN_RENDERER_SCHEME = "t3learn";
export const T3_LEARN_LINUX_DESKTOP_ENTRY = "io.github.aabdel0181.OminaX.desktop";
export const T3_LEARN_HOME_DIRECTORY = ".ominax";
export const T3_LEARN_HOME_ENV = "OMINAX_HOME";
export const T3_LEARN_ELECTRON_USER_DATA = "ominax";
/** Tailscale Serve maps a port machine-wide; T3 Code defaults to 443. */
export const T3_LEARN_TAILSCALE_SERVE_PORT = 8443;

/** Names before the OminaX rename (REL-45). Installs made with them keep working: accept, alias or migrate. */
export const T3_LEARN_LEGACY = {
  repository: "aabdel0181/t3-learn",
  appId: "io.github.aabdel0181.t3learn",
  executableName: "t3learn",
  command: "t3-learn",
  desktopScheme: "t3learn",
  linuxDesktopEntry: "io.github.aabdel0181.T3Learn.desktop",
  homeDirectory: ".t3-learn",
  homeEnv: "T3LEARN_HOME",
  electronUserData: "t3learn",
} as const;
