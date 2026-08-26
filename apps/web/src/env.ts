/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

/**
 * True when hosted by the Qt shell (apps/desktop-qt), which injects
 * window.t3Shell at document creation. The shell renders parts of the chrome
 * itself; the app publishes what they need and hides its own copies.
 */
export const isT3Shell = typeof window !== "undefined" && window.t3Shell !== undefined;
