import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { chunkLoadState } from "./lib/chunkReloadGuard";

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// index.css gates hover variants on these markers instead of media queries, so a VDI/VM mouse that
// Chromium reports as non-hovering can set them too.
const root = document.documentElement;
const hoverMarkers = [
  ["data-hover", window.matchMedia("(hover: hover)")],
  ["data-any-hover", window.matchMedia("(any-hover: hover)")],
] as const;
let lastPointerIsMouse = false;
const syncHoverMarkers = () => {
  for (const [name, query] of hoverMarkers) {
    root.toggleAttribute(name, query.matches || lastPointerIsMouse);
  }
};
for (const [, query] of hoverMarkers) query.addEventListener("change", syncHoverMarkers);
syncHoverMarkers();

if (!hoverMarkers[1][1].matches) {
  const setLastPointer = (isMouse: boolean) => {
    if (isMouse === lastPointerIsMouse) return;
    lastPointerIsMouse = isMouse;
    syncHoverMarkers();
  };
  // Capture phase: a handler that stops propagation must not hide the pointer type.
  const options = { capture: true, passive: true };
  window.addEventListener(
    "pointermove",
    (event) => setLastPointer(event.pointerType === "mouse"),
    options,
  );
  // A tap may never move, so presses clear the marker before its hover sticks. They never set
  // it: the app replays synthetic mouse presses (HostedBrowserWebview).
  window.addEventListener(
    "pointerdown",
    (event) => event.pointerType !== "mouse" && setLastPointer(false),
    options,
  );
}

const app = <AppRoot router={router} />;

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (chunkLoadState.reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (chunkLoadState.reloadScheduled) return;
    throw error;
  });
