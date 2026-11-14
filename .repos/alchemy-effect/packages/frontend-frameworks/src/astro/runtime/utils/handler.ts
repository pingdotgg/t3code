import type { RouteData } from "astro";
import type { RenderOptions } from "astro/app";
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.4.2 (`src/utils/handler.ts`).
 *
 * The Worker `fetch` handler. Imports zero wrangler code; bindings are read
 * from `cloudflare:workers` env and the `virtual:astro-cloudflare:config`
 * virtual module served by this package's config plugin.
 */
import { env as globalEnv } from "cloudflare:workers";
import {
  cacheProviderEnabled,
  compileImageConfig,
  isPrerender,
  loadPrerenderScope,
} from "virtual:astro-cloudflare:config";
import {
  createErrorPageFetch,
  createLocals,
  fallbackToAssets,
  getClientAddress,
  injectSessionBinding,
  matchStaticAsset,
  type Runtime,
} from "./cf.ts";
import { createGetEnv } from "./env.ts";
import {
  handlePrerenderRequest,
  handleStaticPathsRequest,
  installPrerenderErrorPropagation,
  isPrerenderRequest,
  isStaticPathsRequest,
} from "./prerender.ts";
import { applyCloudflareResponseHeaders } from "./response.ts";

export type { Runtime };

setGetEnv(createGetEnv(globalEnv));

declare global {
  // This is not a real global, but is injected using Vite define to allow us to specify the Images binding name in the config.
  var __ASTRO_IMAGES_BINDING_NAME: string;
}

type CfResponse = Awaited<ReturnType<Required<ExportedHandler<Env>>["fetch"]>>;

const app = createApp();

if (isPrerender) {
  installPrerenderErrorPropagation(app);
}

export async function handle(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<CfResponse> {
  // Sessions must be wired before the prerender branch below — prerender
  // requests return from `handlePrerenderRequest` without falling through,
  // and session-touching pages render inside it.
  injectSessionBinding(app.manifest, env);

  // Handle prerender endpoints (only active during build prerender phase)
  if (isPrerender) {
    const isStaticPaths = isStaticPathsRequest(request);
    if (isStaticPaths || isPrerenderRequest(request)) {
      await app.getLogger();
      // Install the isolate's render scope so concurrent prerender requests
      // each collect their metadata in their own per-render store. The
      // loader thunk is generated into the virtual config module only for the
      // prerender environment, keeping the module — and its `node:async_hooks`
      // import — out of production worker output entirely; the install
      // itself is first-wins, making the per-request call idempotent.
      (await loadPrerenderScope?.())?.ensurePrerenderScope();
      // Without build-time image optimization, prerendered pages keep the runtime image URLs.
      const options = { staticImages: compileImageConfig !== null };
      return (isStaticPaths
        ? handleStaticPathsRequest(app, options)
        : handlePrerenderRequest(app, request, options)) as unknown as CfResponse;
    }
  }

  // NOTE this ASSETS binding path is needed for users who are using `run_worker_first` routing
  const staticAsset = matchStaticAsset(app.manifest, request.url, env);
  if (staticAsset) return staticAsset as CfResponse;

  let routeData: RouteData | undefined = undefined;
  if (app.isDev()) {
    const result = await app.devMatch(app.getPathnameFromRequest(request));
    if (result) {
      routeData = result.routeData;
    }
  } else {
    routeData = app.match(request);
  }

  if (!routeData) {
    // NOTE this ASSETS binding path is needed for users who are using `run_worker_first` routing
    const asset = await fallbackToAssets(request.url, env);
    if (asset) return asset as CfResponse;
  }

  const locals = createLocals(context);

  const waitUntil: RenderOptions["waitUntil"] = context.waitUntil.bind(context);

  const response = await app.render(request, {
    routeData,
    locals,
    waitUntil,
    prerenderedErrorPageFetch: createErrorPageFetch(env),
    clientAddress: getClientAddress(request),
  });

  // Collect cookies before any rebuild: `setCookieHeaders` looks the
  // response up by identity, so it must see the original object.
  const setCookieHeaders = app.setCookieHeaders ? [...app.setCookieHeaders(response)] : [];

  return applyCloudflareResponseHeaders(response, setCookieHeaders, cacheProviderEnabled);
}
