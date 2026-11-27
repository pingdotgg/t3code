import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { trackKeyboardLayout } from "./keyboardLayout";
import { cloudAuthProvider } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { chunkLoadState } from "./lib/chunkReloadGuard";

const stopTrackingKeyboardLayout = trackKeyboardLayout();
import.meta.hot?.dispose(stopTrackingKeyboardLayout);

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;

// Split by provider and runtime to keep sign-in code out of local startup, and clerk-js out of
// browser builds. An OpenID Connect provider, when configured, replaces Clerk entirely.
const authProvider = cloudAuthProvider();
const managedAuthShell: Promise<(app: React.ReactNode) => React.ReactNode> | null =
  authProvider === "oidc"
    ? import("./components/oidc/OidcManagedAuthShell").then(({ default: Shell }) => (child) => (
        <Shell>{child}</Shell>
      ))
    : authProvider === "clerk" && clerkPublishableKey
      ? (isElectron
          ? import("./components/clerk/ElectronManagedAuthShell")
          : import("./components/clerk/BrowserManagedAuthShell")
        ).then(({ default: Shell }) => (child) => (
          <Shell publishableKey={clerkPublishableKey}>{child}</Shell>
        ))
      : null;

export const startup = Promise.all([
  managedAuthShell,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(([wrapWithManagedAuth]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (chunkLoadState.reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>{wrapWithManagedAuth ? wrapWithManagedAuth(app) : app}</React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (chunkLoadState.reloadScheduled) return;
    throw error;
  });
