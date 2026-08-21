/**
 * Dev-only entry that loads React Grab, disabled.
 *
 * Never imported by application code. `reactGrabDevPlugin` in `vite.config.ts`
 * injects it as the first module script in `<head>` during `vite dev`, and that
 * placement is the whole point: React reads
 * `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` while `react-dom` evaluates, so
 * bippy (React Grab's fiber layer) has to install that hook before the app
 * entry's module graph runs. A dynamic import from inside `main.tsx` is already
 * too late — static imports hoist `react-dom` ahead of any body code.
 *
 * Because the plugin only applies to `serve`, no production HTML references
 * this file, so it never enters a shipped bundle. See `reactGrabBoundary.test.ts`.
 */

// Type-only import, erased at build time (the `api` annotation below is what
// keeps it from being "unused"). Its other job is making this file a module
// rather than a global script, which is what allows the top-level `await`
// further down — a bare `export {}` would do the same but trips a lint rule
// against empty import/export specifier lists.
import type { ReactGrabAPI } from "react-grab";

// Installed before react-grab ever mounts anything, so its host (marked
// `[data-react-grab]`) is hidden from the instant it first appears — no flash,
// and it stays hidden even if react-grab tears the host down and recreates it
// later, since the rule targets the selector, not today's specific element.
// `reactGrab.ts` toggles `disabled` on this same <style> to show/hide it;
// react-grab's own "disabled" state only collapses its toolbar to a small
// persistent dot, which isn't what turning our setting off should leave
// behind.
const hideOverlayStyle = document.createElement("style");
hideOverlayStyle.textContent = "[data-react-grab] { display: none !important; }";
document.head.appendChild(hideOverlayStyle);
// A freshly created <style> element defaults to enabled (`.disabled === false`),
// so the overlay starts hidden here too, matching the `setEnabled(false)` below.
window.__t3ReactGrabSetOverlayVisible = (visible) => {
  hideOverlayStyle.disabled = visible;
};

// Must be set before React Grab's entry module evaluates: that module otherwise
// self-initializes on import, which enables the overlay immediately and fires a
// version-check request at react-grab.com. We initialize by hand below instead.
window.__REACT_GRAB_DISABLED__ = true;

const { init, setGlobalApi } = await import("react-grab");

// `init({ enabled: false })` is NOT "create a real instance, but start it
// disabled" — react-grab's init bails out to a permanently inert stub object
// whenever the resolved `enabled` option is `false` (or on a second `init`
// call at all; it's a one-shot singleton). That stub's `setEnabled` is a
// no-op and `isEnabled` is hardcoded to always return false, so a later
// `setReactGrabEnabled(true)` from the settings bridge would silently do
// nothing forever. Getting a real, toggleable instance means initing enabled
// and disabling it through the real (fully functional) `setEnabled` instead.
const api: ReactGrabAPI = init({ enabled: true, telemetry: false });
api.setEnabled(false);

// `init` bypassed the entry module's bookkeeping, so publish the instance
// ourselves — `window.__REACT_GRAB__` is how the settings bridge, plugins, and
// the devtools console reach it.
setGlobalApi(api);

// Not checking isInstrumentationActive() here: react-dom hasn't loaded yet at
// this point (this script runs before main.tsx's module graph, which is the
// whole point — see the file comment), so it would always read false.
// `reactGrab.ts` checks it once the setting actually turns the overlay on,
// which is always after React has mounted.
