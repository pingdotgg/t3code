import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { ConnectProvidersRoot, useConnectProviders } from "./cloud/connectProviderContext";
import { providerHasRelay } from "./cloud/connectProviders";
import { hasClerkPublicConfig } from "./cloud/publicConfig";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

// MT Code keeps the fork's connect-provider Clerk gate (the key may come from an
// embedded provider at runtime), but the Clerk runtime itself is a split chunk
// like upstream: nothing Clerk-related sits in the startup graph for local-mode
// users.
const ConnectClerkGate = React.lazy(() => import("./components/clerk/ConnectClerkGate"));

const envClerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function ClerkGate({ children }: { readonly children: React.ReactNode }) {
  const { embedded } = useConnectProviders();
  const publishableKey = embedded?.clerkPublishableKey ?? envClerkPublishableKey;
  const enableClerk = Boolean(publishableKey && (embedded || hasClerkPublicConfig()));
  const wrapRelay = Boolean(embedded && providerHasRelay(embedded));

  if (!enableClerk || !publishableKey) {
    return children;
  }

  return (
    <React.Suspense fallback={null}>
      <ConnectClerkGate
        key={embedded?.id ?? "clerk"}
        publishableKey={publishableKey}
        wrapRelay={wrapRelay}
      >
        {children}
      </ConnectClerkGate>
    </React.Suspense>
  );
}

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

// When Clerk is configured statically, resolve its chunk before the first
// commit too, so the boot splash holds until real UI paints (same reasoning as
// the route chunks below). An embedded provider that enables Clerk later goes
// through the gate's Suspense boundary instead.
const clerkGateModule =
  envClerkPublishableKey && hasClerkPublicConfig()
    ? import("./components/clerk/ConnectClerkGate")
    : null;

// React's first commit clears the #root boot splash, so resolve the Clerk gate and the
// initial route chunks first; the splash then holds until real UI paints.
export const startup = Promise.all([clerkGateModule, router.load()])
  .then(() => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ConnectProvidersRoot>
          <ClerkGate>{app}</ClerkGate>
        </ConnectProvidersRoot>
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    console.error("T3 Code failed to load its startup chunks.", error);
    const bootShell = document.getElementById("boot-shell");
    if (bootShell) bootShell.textContent = "T3 Code could not load. Reload to try again.";
  });
