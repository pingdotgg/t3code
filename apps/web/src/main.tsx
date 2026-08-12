import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { syncDocumentAppZoomVariable } from "./lib/titlebar";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

const scrollingTimers = new WeakMap<HTMLElement, number>();

document.addEventListener(
  "scroll",
  (event) => {
    const scrollingElement =
      event.target instanceof HTMLElement ? event.target : document.documentElement;
    const existingTimer = scrollingTimers.get(scrollingElement);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    scrollingElement.classList.add("is-scrolling");
    scrollingTimers.set(
      scrollingElement,
      window.setTimeout(() => {
        scrollingElement.classList.remove("is-scrolling");
        scrollingTimers.delete(scrollingElement);
      }, 500),
    );
  },
  { capture: true, passive: true },
);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
  syncDocumentAppZoomVariable();
}

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
