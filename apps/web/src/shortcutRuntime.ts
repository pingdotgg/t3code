/**
 * Which modifier the abstract `mod` keybinding token resolves to.
 *
 * On macOS the browser reserves most Cmd combinations (Cmd+N, Cmd+W, Cmd+L,
 * Cmd+1..9, ...) before the page ever sees a keydown, so those bindings are
 * unreachable in a tab no matter how early we call `preventDefault`. Ctrl is
 * almost entirely free there, so browser sessions resolve `mod` to Ctrl.
 *
 * The desktop app owns its whole menu bar and keeps Cmd. Non-mac platforms
 * already used Ctrl for `mod`, so they are unaffected in both runtimes.
 *
 * This lives in its own module (rather than reading settings inside
 * `keybindings.ts`) so the matcher stays free of the settings import graph.
 */
export type ShortcutRuntime = "desktop" | "browser";

export function resolveShortcutRuntime(input: {
  isElectron: boolean;
  modKeyFlipEnabled: boolean;
}): ShortcutRuntime {
  // Desktop never flips; the setting is the browser-side opt-out.
  if (input.isElectron || !input.modKeyFlipEnabled) return "desktop";
  return "browser";
}

// Defaults to the pre-flip behavior. `startShortcutRuntimeSync` runs during
// startup, before React mounts, so a browser session flips well ahead of the
// first keydown.
let shortcutRuntime: ShortcutRuntime = "desktop";

export function getShortcutRuntime(): ShortcutRuntime {
  return shortcutRuntime;
}

export function setShortcutRuntime(runtime: ShortcutRuntime): void {
  shortcutRuntime = runtime;
}
