import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { trackKeyboardLayout } from "./keyboardLayout";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { chunkLoadState } from "./lib/chunkReloadGuard";

const stopTrackingKeyboardLayout = trackKeyboardLayout();
import.meta.hot?.dispose(stopTrackingKeyboardLayout);

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// index.css gates hover variants on these markers instead of media queries, so a VDI/VM mouse that
// Chromium reports as non-hovering can set them too.
const root = document.documentElement;
const hoverQuery = window.matchMedia("(hover: hover)");
const anyHoverQuery = window.matchMedia("(any-hover: hover)");
let lastPointerIsMouse = false;
const syncHoverMarkers = () => {
  const mouseFallback = lastPointerIsMouse && !anyHoverQuery.matches;
  root.toggleAttribute("data-hover", hoverQuery.matches || mouseFallback);
  root.toggleAttribute("data-any-hover", anyHoverQuery.matches || mouseFallback);
};
hoverQuery.addEventListener("change", syncHoverMarkers);
anyHoverQuery.addEventListener("change", syncHoverMarkers);
syncHoverMarkers();

const setLastPointer = (isMouse: boolean) => {
  if (isMouse === lastPointerIsMouse) return;
  lastPointerIsMouse = isMouse;
  syncHoverMarkers();
};
// Capture phase: a handler that stops propagation must not hide the pointer type.
const pointerOptions = { capture: true, passive: true };
window.addEventListener(
  "pointermove",
  (event) => setLastPointer(event.pointerType === "mouse"),
  pointerOptions,
);
// A tap may never move, so presses clear the marker before its hover sticks. They never set
// it: the app replays synthetic mouse presses (HostedBrowserWebview).
window.addEventListener(
  "pointerdown",
  (event) => event.pointerType !== "mouse" && setLastPointer(false),
  pointerOptions,
);

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
