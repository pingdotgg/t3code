// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.

interface Env {
  __VITE_MIDDLEWARE__: Fetcher;
  ASSET_WORKER: Fetcher;
}

/** Set by the Vite middleware handler when no Vite middleware served the request. */
const VITE_MISS_HEADER = "x-alchemy-vite-asset-miss";

/**
 * The dev `ASSETS` binding a Worker calls.
 *
 * Mirrors `@cloudflare/vite-plugin`'s dev wiring, which binds `ASSETS` to the
 * Vite dev server's middleware: anything Vite serves (source files a Worker
 * imports by URL, `/@fs/` dependency files, `public/`) resolves as it does in
 * the browser. Requests Vite doesn't serve fall back to the asset worker,
 * which applies the HTML handling and not-found rules.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.__VITE_MIDDLEWARE__.fetch(request.clone());
    if (response.headers.has(VITE_MISS_HEADER)) {
      return env.ASSET_WORKER.fetch(request);
    }
    return response;
  },
};
