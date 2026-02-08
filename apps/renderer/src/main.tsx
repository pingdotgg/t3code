import React from "react";
import ReactDOM from "react-dom/client";
import "highlight.js/styles/github-dark.css";

import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
