// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.4.2 (`src/utils/prerender.ts`).
 *
 * Prerender utilities for the Cloudflare adapter. These endpoints are only
 * active during the (workerd) prerender build phase and are not available in
 * production or development; the workerd prerenderer (`../../prerenderer.ts`)
 * drives them. The `cloudflare-binding` image transform endpoint is not
 * vendored (the IMAGES binding is not supported).
 */
import type { BaseApp, RenderErrorOptions } from "astro/app";
import { renderForPrerender } from "astro/app";
import { deserializeRouteData, serializeRouteData } from "astro/app/manifest";
import { StaticPaths } from "astro:static-paths";
import type { PrerenderRequest, StaticPathsResponse } from "../prerender-types.ts";
import { PRERENDER_ENDPOINT, STATIC_PATHS_ENDPOINT } from "./prerender-constants.ts";
import { createFramedPrerenderResponse } from "./prerender-response.ts";

/**
 * Replicates core's `BuildErrorHandler` semantics on the worker app during
 * the prerender phase.
 */
export function installPrerenderErrorPropagation(app: BaseApp): void {
  const originalRenderError = app.renderError.bind(app);
  app.renderError = async (request: Request, options: RenderErrorOptions): Promise<Response> => {
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

interface PrerenderOptions {
  /** Whether prerendered pages get build-time image URLs, for the build to generate. */
  staticImages: boolean;
}

/**
 * Handles the static paths request, returning all paths that need prerendering.
 */
export async function handleStaticPathsRequest(
  app: BaseApp,
  { staticImages }: PrerenderOptions,
): Promise<Response> {
  const staticPaths = new StaticPaths(app);
  const { paths, metadata } = await staticPaths.getAllWithMetadata({ staticImages });
  const response: StaticPathsResponse = {
    paths: paths.map(({ pathname, route, cacheKey }) => ({
      pathname,
      route: serializeRouteData(route, app.manifest.trailingSlash),
      cacheKey,
    })),
    metadata,
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
  { staticImages }: PrerenderOptions,
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
  try {
    // `renderForPrerender` buffers the body (so streaming errors surface
    // here) and collects the content entries and image transforms resolved
    // during this render — scoped to this request's async context, so
    // concurrent prerender requests attribute correctly. A length-prefixed
    // JSON header carries the metadata before the raw response bytes.
    const { response, metadata } = await renderForPrerender(app, prerenderRequest, {
      routeData,
      staticImages,
    });
    return createFramedPrerenderResponse(response, metadata);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // HTTP headers cannot contain newlines.
    const headerSafe = message.replace(/[\r\n]+/g, " ");
    return new Response(message, {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
        "x-astro-prerender-error": headerSafe,
      },
    });
  }
}
