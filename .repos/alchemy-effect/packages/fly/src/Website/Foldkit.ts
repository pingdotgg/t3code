import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import type { ViteProps } from "./Vite.ts";

/** Configuration for a Foldkit website. */
export interface FoldkitProps extends FrameworkSiteProps {
  /** Serializable overrides merged over vite.config.*. */
  vite?: ViteProps["vite"];
}

/**
 * Deploy a [Foldkit](https://foldkit.dev) application to Fly Machines.
 * Browser-only apps use SPA routing. With `ssr.build` enabled in the
 * Foldkit Vite plugin, prerendered pages and assets are served first,
 * followed by Foldkit's generated request handler for SSR and hybrid routes.
 *
 * The build uses `@alchemy.run/frontend-frameworks/foldkit` and the
 * project's Vite configuration. No application adapter is required.
 * Native Foldkit development and live reload run without cloud resources;
 * `Alchemy.remote()` opts into a live deployment during development.
 *
 * ### Creating a Website
 * **Example:** SPA, SSR, or prerendered Foldkit application
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Runtime environment for server-rendered pages
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web", {
 *   rootDir: "./app",
 *   env: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  frameworkSite(id, props, {
    name: "Foldkit",
    framework: "@alchemy.run/frontend-frameworks/foldkit",
    target: "@alchemy.run/frontend-frameworks/foldkit/node",
    options: {
      vite: props.vite,
      notFoundHandling:
        props.assets?.notFoundHandling === "single-page-application"
          ? "spa"
          : props.assets?.notFoundHandling,
      htmlHandling: props.assets?.htmlHandling,
    },
  });
