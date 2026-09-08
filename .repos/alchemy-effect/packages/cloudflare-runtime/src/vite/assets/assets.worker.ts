// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import {
  AssetWorkerInner,
  type Env as BaseEnv,
} from "../../internal/workers-shared/workers/asset-worker/index.ts";

const UNKNOWN_HOST = "http://localhost";

interface Env extends BaseEnv {
  __VITE_HTML_EXISTS__: Fetcher;
  __VITE_FETCH_HTML__: Fetcher;
  __VITE_HEADERS__: Record<string, string | Array<string> | undefined>;
}

/**
 * Asset worker that integrates with the Vite dev server.
 *
 * - {@link unstable_exists} delegates HTML lookups to Vite so that virtual
 *   HTML routes and files in `publicDir` are discoverable even though they
 *   are not in the on-disk manifest at startup.
 * - {@link unstable_getByETag} streams the HTML body back through Vite so
 *   `transformIndexHtml` runs (enabling HMR, script injection, etc.).
 * - {@link fetch} strips `ETag` / `Cache-Control` (Vite has its own caching
 *   semantics during dev) and appends any custom headers configured via
 *   `server.headers` in the Vite config.
 *
 * Mirrors the behavior of `CustomAssetWorker` in
 * `upstream/workers-sdk/packages/vite-plugin-cloudflare/src/workers/asset-worker`.
 */
export default class ViteAssetWorker extends AssetWorkerInner<Env> {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    const modified = new Response(response.body, response);
    modified.headers.delete("ETag");
    modified.headers.delete("Cache-Control");

    for (const [key, value] of Object.entries(this.env.__VITE_HEADERS__)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          modified.headers.append(key, item);
        }
      } else if (value !== undefined) {
        modified.headers.set(key, String(value));
      }
    }

    return modified;
  }

  override async unstable_getByETag(eTag: string) {
    const url = new URL(eTag, UNKNOWN_HOST);
    const response = await this.env.__VITE_FETCH_HTML__.fetch(url);
    if (!response.body) {
      throw new Error(`Unexpected error. No HTML found for "${eTag}".`);
    }
    return {
      readableStream: response.body,
      contentType: "text/html",
      cacheStatus: "MISS",
    } as const;
  }

  override async unstable_exists(pathname: string) {
    // Guard against `//` collapsing into an invalid URL.
    const url = new URL(pathname.replace(/^\/{2,}/, "/"), UNKNOWN_HOST);
    const response = await this.env.__VITE_HTML_EXISTS__.fetch(url);
    return response.json() as Promise<string | null>;
  }
}
