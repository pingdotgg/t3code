import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";

// Lives in the `ssr` environment (no `react-server` condition), so it can use
// `react-dom/server` — which would fail if imported directly in the worker's
// `rsc` entry. The worker reaches it via `loadModule("ssr", "worker-ssr")`.
export function renderWorkerHtml(): string {
  return renderToStaticMarkup(
    createElement("section", null, "Worker render via the ssr environment."),
  );
}
