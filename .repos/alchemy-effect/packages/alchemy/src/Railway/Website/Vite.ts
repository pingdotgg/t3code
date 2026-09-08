import * as Namespace from "../../Namespace.ts";
import {
  makeFrameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vite build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The Node container deploy target for the Vite build. */
export const VITE_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/node";

const viteOptions = (props: ViteProps) =>
  props.vite !== undefined &&
  (props.vite.outDir !== undefined || props.vite.base !== undefined)
    ? { vite: props.vite }
    : undefined;

export interface ViteProps extends FrameworkSiteProps {
  /**
   * Serializable Vite config merged OVER the project's own `vite.config.*`.
   */
  vite?: {
    outDir?: string;
    base?: string;
  };
}

/**
 * Deploy a plain [Vite](https://vite.dev) application to Railway: static
 * assets (the `vite build` output) served by a generated Node static-file
 * server on one `Railway.Service`. For client-only projects — React/Vue/Solid
 * SPAs, `index.html` multi-page apps — whose entire deployable output is
 * static assets.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/node` deploy target — the package
 * must be installed in your project. Your project's own `vite.config.*`
 * (plugins included) drives the build.
 *
 * During `alchemy dev` the site is Vite's own dev server (native HMR) and
 * no cloud resources are created — the site's `url` is the dev server's
 * local address. `Alchemy.remote()` opts back into the full deployment.
 *
 * SSR frameworks that wrap Vite deploy through their own composites
 * ({@link Astro | Railway.Website.Astro}, {@link SvelteKit | Railway.Website.SvelteKit},
 * {@link Octane | Railway.Website.Octane}, ...) — this composite never
 * creates a framework server module.
 *
 * ### Creating Vite Sites
 * **Example:** Basic Vite SPA
 * ```typescript
 * const site = yield* Railway.Website.Vite("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* Railway.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Existing Project
 * ```typescript
 * const project = yield* Railway.Project("Site");
 * const site = yield* Railway.Website.Vite("Web", {
 *   project,
 * });
 * ```
 *
 * ### Multi-Page Sites
 * **Example:** Per-Route HTML Pages with a 404 Page
 * ```typescript
 * const site = yield* Railway.Website.Vite("Docs", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Build Configuration
 * **Example:** Custom Output Directory and Base Path
 * ```typescript
 * const site = yield* Railway.Website.Vite("Docs", {
 *   vite: { outDir: "build", base: "/docs/" },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (HMR included); no Project or Service is created.
 * const site = yield* Railway.Website.Vite("Web");
 * ```
 *
 * @resource
 * @product Website
 */
export const Vite = (id: string, props: ViteProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vite",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_NODE_TARGET_SPECIFIER,
    options: {
      ...viteOptions(props),
      notFoundHandling: "spa",
      htmlHandling: props.assets?.htmlHandling,
    },
    static: staticConfigFromAssets(props.assets, {
      notFoundHandling: "single-page-application",
    }),
  }).pipe(Namespace.push(id));
