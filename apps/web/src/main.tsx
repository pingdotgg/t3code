import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory, RouterProvider } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = resolveCloudPublicConfig().clerkPublishableKey;
const T3ConnectClerkProvider = React.lazy(() =>
  isElectron
    ? import("./components/connect/T3ConnectClerkProvider.electron")
    : import("./components/connect/T3ConnectClerkProvider.web"),
);

const AuthWrapper = (props: { children: React.ReactNode }) =>
  clerkPublishableKey && hasCloudPublicConfig() ? (
    <React.Suspense fallback={null}>
      <T3ConnectClerkProvider publishableKey={clerkPublishableKey}>
        {props.children}
      </T3ConnectClerkProvider>
    </React.Suspense>
  ) : (
    props.children
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthWrapper>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>
    </AuthWrapper>
  </React.StrictMode>,
);
