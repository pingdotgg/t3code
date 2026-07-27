/// <reference types="@vitejs/plugin-rsc/types" />
import handler from "./entry.rsc.single";

// The distilled Cloudflare worker wrapper expects a `{ fetch }` default export;
// the RSC single-worker handler is a bare (request) => Response function.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Worker code that needs a non-`react-server` module (here `react-dom/server`)
    // must not import it directly in this `rsc` entry — it loads it from the
    // `ssr` environment via `loadModule`. Exercises a custom (non-`index`) ssr
    // input + cross-environment load through the distilled plugin.
    if (url.pathname === "/worker-render") {
      const { renderWorkerHtml } = await import.meta.viteRsc.loadModule<
        typeof import("./worker-ssr")
      >("ssr", "worker-ssr");
      return Response.json({ ok: true, html: renderWorkerHtml() });
    }

    return handler(request);
  },
};
