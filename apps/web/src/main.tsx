import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "dockview/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { TooltipProvider } from "./components/ui/tooltip";
import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider delay={75} closeDelay={0}>
      <RouterProvider router={router} />
    </TooltipProvider>
  </React.StrictMode>,
);
