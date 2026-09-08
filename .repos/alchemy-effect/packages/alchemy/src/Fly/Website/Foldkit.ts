import { Vite, type ViteProps } from "./Vite.ts";

export interface FoldkitProps extends ViteProps {}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to Fly. Foldkit apps are
 * client-only Vite projects, so this is {@link Vite} with SPA fallback
 * to `index.html` so deep links boot the app.
 *
 *
 * ### Creating Foldkit Sites
 * **Example:** Foldkit app
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web");
 * ```
 *
 * **Example:** Project in a subdirectory
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Single-Page Application Routing
 * **Example:** Serving a real 404 page
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  Vite(id, {
    ...props,
    assets: {
      notFoundHandling: "single-page-application",
      ...props.assets,
    },
  });
