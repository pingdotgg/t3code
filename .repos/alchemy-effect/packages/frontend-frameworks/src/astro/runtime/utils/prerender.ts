// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.1.3 (`src/utils/prerender.ts`).
 *
 * Prerender utilities for the Cloudflare adapter. These endpoints are only
 * active during the (workerd) prerender build phase and are not available in
 * production or development. This package hardwires node prerendering
 * (`prerenderEnvironment: 'node'`), so they are effectively dormant, but the
 * handler keeps the code path so a workerd prerenderer can be reintroduced
 * without touching the runtime.
 */
import type { BaseApp, RenderErrorOptions } from "astro/app";
import { deserializeRouteData, serializeRouteData } from "astro/app/manifest";
import { StaticPaths } from "astro:static-paths";
import type {
  PrerenderRequest,
  SerializedStaticImageEntry,
  StaticImagesResponse,
  StaticPathsResponse,
} from "../prerender-types.ts";
import {
  PRERENDER_ENDPOINT,
  STATIC_IMAGES_ENDPOINT,
  STATIC_PATHS_ENDPOINT,
} from "./prerender-constants.ts";

/**
 * Replicates core's `BuildErrorHandler` semantics on the worker app during
 * the prerender phase.
 */
export function installPrerenderErrorPropagation(app: BaseApp): void {
  const originalRenderError = app.renderError.bind(app);
  app.renderError = async (
    request: Request,
    options: RenderErrorOptions,
  ): Promise<Response> => {
    if (options.status === 500) {
      if (options.response) {
        return options.response;
      }
      throw options.error;
    }
    return originalRenderError(request, options);
  };
}

/**
 * Checks if the request is for the static paths prerender endpoint.
 */
export function isStaticPathsRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === STATIC_PATHS_ENDPOINT && request.method === "POST";
}

/**
 * Checks if the request is for the prerender endpoint.
 */
export function isPrerenderRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === PRERENDER_ENDPOINT && request.method === "POST";
}

/**
 * Handles the static paths request, returning all paths that need prerendering.
 */
export async function handleStaticPathsRequest(
  app: BaseApp,
): Promise<Response> {
  const staticPaths = new StaticPaths(app);
  const paths = await staticPaths.getAll();
  const response: StaticPathsResponse = {
    paths: paths.map(({ pathname, route }) => ({
      pathname,
      route: serializeRouteData(route, app.manifest.trailingSlash),
    })),
  };
  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handles a prerender request, rendering the specified page. The response
 * body is fully buffered so streaming errors surface as a 500.
 */
export async function handlePrerenderRequest(
  app: BaseApp,
  request: Request,
): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    headers.append(key, value);
  }
  const body: PrerenderRequest = await request.json();
  const routeData = deserializeRouteData(body.routeData);
  const prerenderRequest = new Request(body.url, {
    method: "GET",
    headers,
  });
  // Buffer the full body to catch streaming errors before the HTTP layer
  // commits a 200 status.
  try {
    const response = await app.render(prerenderRequest, { routeData });
    const bufferedBody = await response.arrayBuffer();
    return new Response(bufferedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
        "x-astro-prerender-error": message,
      },
    });
  }
}

export function isStaticImagesRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === STATIC_IMAGES_ENDPOINT && request.method === "POST";
}

/** Serializes the global staticImages map collected in workerd back to the Node-side build. */
export function handleStaticImagesRequest(): Response {
  const staticImages = globalThis.astroAsset?.staticImages;
  if (!staticImages || staticImages.size === 0) {
    return new Response("[]", {
      headers: { "Content-Type": "application/json" },
    });
  }

  const entries: StaticImagesResponse = [];
  for (const [originalPath, { originalSrcPath, transforms }] of staticImages) {
    const serializedTransforms: SerializedStaticImageEntry["transforms"] = [];
    for (const [hash, { finalPath, transform }] of transforms) {
      serializedTransforms.push({
        hash,
        finalPath,
        transform: transform as Record<string, any>,
      });
    }
    entries.push({
      originalPath,
      originalSrcPath,
      transforms: serializedTransforms,
    });
  }

  return new Response(JSON.stringify(entries), {
    headers: { "Content-Type": "application/json" },
  });
}
