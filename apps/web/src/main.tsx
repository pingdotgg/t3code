import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { installIosStandaloneBackSwipeGuard } from "./iosStandaloneBackSwipeGuard";
import { getRouter } from "./router";
import { APP_BASE_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { installPwaAppBadgeSync } from "./pwa/appBadge";
import { registerPwaServiceWorker } from "./pwa/registerPwaServiceWorker";
import { installServiceWorkerNotificationNavigation } from "./push/notificationNavigation";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);
installServiceWorkerNotificationNavigation(router);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

installIosStandaloneBackSwipeGuard();
installPwaAppBadgeSync();
registerPwaServiceWorker();

document.title = APP_BASE_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
