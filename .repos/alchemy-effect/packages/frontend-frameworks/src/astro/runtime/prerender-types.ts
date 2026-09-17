// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Vendored from `@astrojs/cloudflare` v14.1.3 (`src/prerender-types.ts`).
import type { SerializedRouteData } from "astro/app/manifest";

/**
 * A pathname with its serialized route data, used for prerendering over HTTP.
 */
interface SerializedPathWithRoute {
  pathname: string;
  route: SerializedRouteData;
}

/**
 * Response from the /__astro_static_paths endpoint.
 */
export interface StaticPathsResponse {
  paths: Array<SerializedPathWithRoute>;
}

/**
 * Request body for the /__astro_prerender endpoint.
 */
export interface PrerenderRequest {
  url: string;
  routeData: SerializedRouteData;
}

export interface SerializedStaticImageEntry {
  originalPath: string;
  originalSrcPath: string | undefined;
  transforms: Array<{
    hash: string;
    finalPath: string;
    transform: Record<string, any>;
  }>;
}

export type StaticImagesResponse = Array<SerializedStaticImageEntry>;
