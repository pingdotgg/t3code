import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

/**
 * Same-origin proxy for the browser's `AtomRpc` client. The browser can't use a
 * Cloudflare service binding directly, so the `AtomRpc` protocol points at this
 * `/rpc` route and we forward the request body to the private `BACKEND` worker
 * over the service binding. This keeps the backend off the public internet and
 * avoids CORS.
 */
export const Route = createFileRoute("/rpc")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        return await env.BACKEND.fetch(request);
      },
    },
  },
});
