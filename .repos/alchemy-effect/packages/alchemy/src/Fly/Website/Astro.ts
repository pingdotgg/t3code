import {
  frameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro";

/** The Node container deploy target for the Astro build. */
export const ASTRO_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro/node";

export interface AstroProps extends FrameworkSiteProps {
  /**
   * Serializable Astro config merged OVER the project's own
   * `astro.config.*` (which loads natively). `adapter` is owned by the Node
   * deploy target and may not be set here.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand; individual
     * pages opt into prerendering with `export const prerender = true`.
     * `"static"` prerenders every page at build time and deploys
     * assets-only (no SSR server).
     * @default "server"
     */
    output?: "server" | "static";
    /** Source directory, relative to `rootDir`. @default "./src" */
    srcDir?: string;
    /** Public (static passthrough) directory. @default "./public" */
    publicDir?: string;
    /** Build output directory. @default "./dist" */
    outDir?: string;
    /** Trailing-slash handling for routes. */
    trailingSlash?: "always" | "never" | "ignore";
  };
}

/**
 * Deploy an [Astro](https://astro.build) application to Fly: a Service
 * running the Node adapter's serve entry (static files first, then the
 * framework handler) on port 3000.
 *
 * Pages render on demand by default (`output: "server"`). With
 * `astro: { output: "static" }` every page is prerendered and the deploy
 * is assets-only.
 *
 *
 * ### Creating Astro Sites
 * **Example:** Basic Astro App
 * ```typescript
 * const site = yield* Fly.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Fly.Website.Astro("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 * });
 * ```
 *
 * ### Static Sites
 * **Example:** Fully Static Astro Site
 * ```typescript
 * const site = yield* Fly.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Astro = (id: string, props: AstroProps = {}) => {
  const output = props.astro?.output ?? "server";
  return frameworkSite(id, props, {
    name: "Astro",
    framework: ASTRO_FRAMEWORK_SPECIFIER,
    target: ASTRO_NODE_TARGET_SPECIFIER,
    options: { astro: { ...props.astro, output } },
    static:
      output === "static" ? staticConfigFromAssets(props.assets) : undefined,
  });
};
