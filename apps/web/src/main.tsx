import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";

const APP_ZOOM_STORAGE_KEY = "t3code:app-zoom";
const APP_ZOOM_INSTALL_FLAG = "__t3codeAppZoomInstalled";
const DEFAULT_ZOOM_LEVEL = 1;
const MIN_ZOOM_LEVEL = 0.7;
const MAX_ZOOM_LEVEL = 1.8;
const ZOOM_STEP = 0.1;

const roundZoomLevel = (value: number) => Math.round(value * 10) / 10;

const clampZoomLevel = (value: number) =>
  roundZoomLevel(Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, value)));

const readStoredZoomLevel = () => {
  const storedValue = window.localStorage.getItem(APP_ZOOM_STORAGE_KEY);
  const parsedValue = Number.parseFloat(storedValue ?? "");

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_ZOOM_LEVEL;
  }

  return clampZoomLevel(parsedValue);
};

const applyZoomLevel = (value: number) => {
  const normalizedValue = clampZoomLevel(value);
  document.documentElement.style.zoom = String(normalizedValue);
  window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, String(normalizedValue));
};

const shouldHandleZoomShortcut = (event: KeyboardEvent) => {
  const isModPressed = event.ctrlKey || event.metaKey;

  if (!isModPressed || event.altKey) {
    return false;
  }

  return ["+", "=", "-", "_", "0", "NumpadAdd", "NumpadSubtract", "Numpad0"].includes(event.key);
};

const installAppZoomControls = () => {
  if ((window as Window & { [APP_ZOOM_INSTALL_FLAG]?: boolean })[APP_ZOOM_INSTALL_FLAG]) {
    return;
  }

  (window as Window & { [APP_ZOOM_INSTALL_FLAG]?: boolean })[APP_ZOOM_INSTALL_FLAG] = true;

  applyZoomLevel(readStoredZoomLevel());

  window.addEventListener("keydown", (event) => {
    if (!shouldHandleZoomShortcut(event)) {
      return;
    }

    event.preventDefault();

    const currentZoomLevel = readStoredZoomLevel();

    if (event.key === "0" || event.key === "Numpad0") {
      applyZoomLevel(DEFAULT_ZOOM_LEVEL);
      return;
    }

    if (event.key === "+" || event.key === "=" || event.key === "NumpadAdd") {
      applyZoomLevel(currentZoomLevel + ZOOM_STEP);
      return;
    }

    applyZoomLevel(currentZoomLevel - ZOOM_STEP);
  });
};

const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

document.title = APP_DISPLAY_NAME;
installAppZoomControls();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
