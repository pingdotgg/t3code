import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./theme/theme.css";

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("index.html is missing the #root container");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
