import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { cloudAuthProvider } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

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

export const startup = Promise.all([managedAuthShell, router.load()])
  .then(([wrapWithManagedAuth]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>{wrapWithManagedAuth ? wrapWithManagedAuth(app) : app}</React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
