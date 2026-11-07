/// <reference types="vite/client" />
// Mirrors `@cloudflare/vite-plugin`'s `playground/spa-with-api/api/index.ts`.
import assetPath from "./asset.txt?no-inline";

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/asset") {
        const response = await env.ASSETS.fetch(new URL(assetPath, request.url));
        return new Response(`Modified: ${await response.text()}`);
      }
      return Response.json({ name: "Cloudflare" });
    }

    const response = await env.ASSETS.fetch(request);
    const modified = new Response(response.body, response);
    modified.headers.append("is-worker-response", "true");
    return modified;
  },
};
