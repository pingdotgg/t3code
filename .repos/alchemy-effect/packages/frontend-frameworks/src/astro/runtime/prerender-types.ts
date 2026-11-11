// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Vendored from `@astrojs/cloudflare` v14.4.2 (`src/prerender-types.ts`).
import type { PrerenderRenderMetadata, StaticPathsMetadata } from "astro";
import type { SerializedRouteData } from "astro/app/manifest";

/**
 * A pathname with its serialized route data, used for prerendering over HTTP.
 */
interface SerializedPathWithRoute {
  pathname: string;
  route: SerializedRouteData;
  cacheKey?: string;
}

/**
 * Response from the /__astro_static_paths endpoint.
 */
export interface StaticPathsResponse {
  paths: Array<SerializedPathWithRoute>;
  metadata?: StaticPathsMetadata;
}

/**
 * Request body for the /__astro_prerender endpoint.
 */
export interface PrerenderRequest {
  url: string;
  routeData: SerializedRouteData;
}

export interface PrerenderResponseMetadata {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  hasBody: boolean;
  /**
   * The metadata collected during the render, or `undefined` when no render
   * scope could be installed in the worker (degraded collection — the path is
   * recorded as "not tracked", which is distinct from tracked-but-empty).
   */
  metadata?: PrerenderRenderMetadata;
}
