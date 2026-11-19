import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Two frames: the first commits the tree, the second runs after it has been painted.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const mark = performance.mark("board:first-paint");
    window.board?.reportFirstPaint(performance.timeOrigin + mark.startTime);
  }),
);
