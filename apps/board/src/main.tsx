import { RegistryContext } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { engineStatusAtom } from "./state/engine";
import { appAtomRegistry } from "./state/registry";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <RegistryContext.Provider value={appAtomRegistry}>
    <StrictMode>
      <App />
    </StrictMode>
  </RegistryContext.Provider>,
);

// Two frames: the first commits the tree, the second runs after it has been painted.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const mark = performance.mark("board:first-paint");
    window.board?.reportFirstPaint(performance.timeOrigin + mark.startTime);
  }),
);

let engineConnectedReported = false;
appAtomRegistry.subscribe(
  engineStatusAtom,
  (status) => {
    if (status.tone !== "ok" || engineConnectedReported) return;
    engineConnectedReported = true;
    const mark = performance.mark("board:engine-connected");
    window.board?.reportEngineConnected(performance.timeOrigin + mark.startTime);
  },
  { immediate: true },
);
