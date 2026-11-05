// T3 Learn installs next to T3 Code, so every name the OS or another app can
// see differs from T3 Code's: app id, data folder, link scheme and command.
// Development builds keep upstream's dev scheme, profile and window names.

export const T3_LEARN_REPOSITORY = "aabdel0181/t3-learn";
export const T3_LEARN_APP_ID = "io.github.aabdel0181.t3learn";
export const T3_LEARN_PRODUCT_NAME = "OminaX";
/** Linux executable and WM class, deb package, Windows install folder and boot service, like upstream's `t3code`. */
export const T3_LEARN_EXECUTABLE_NAME = "t3learn";
/** The CLI command Settings → About installs, like upstream's `t3`. */
export const T3_LEARN_COMMAND = "t3-learn";
export const T3_LEARN_DESKTOP_SCHEME = "t3learn";
export const T3_LEARN_LINUX_DESKTOP_ENTRY = "io.github.aabdel0181.T3Learn.desktop";
export const T3_LEARN_HOME_DIRECTORY = ".t3-learn";
export const T3_LEARN_HOME_ENV = "T3LEARN_HOME";
export const T3_LEARN_ELECTRON_USER_DATA = "t3learn";
/** Tailscale Serve maps a port machine-wide; T3 Code defaults to 443. */
export const T3_LEARN_TAILSCALE_SERVE_PORT = 8443;
