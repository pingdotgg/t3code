import * as Namespace from "alchemy/Namespace";
import { resolveAstroOutput } from "alchemy/Website/AstroOutput";
import * as Effect from "effect/Effect";
import {
  makeFrameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/astro";

/** The Node container deploy target for the Astro build. */
export const ASTRO_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/astro/node";

export interface AstroProps extends FrameworkSiteProps {
  /**
   * Serializable Astro config merged OVER the project's own
   * `astro.config.*` (which loads natively). `adapter` is owned by the
   * Node deploy target and may not be set here.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand;
     * `"static"` prerenders every page at build time and deploys
     * assets-only (no SSR unit). Overrides the `output` in your
     * `astro.config.*`; leave it unset to use the file's value.
     * @default the config file's `output`, else `"server"`
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
 * Deploy an [Astro](https://astro.build) application to a Hetzner Cloud
 * Server: the Node adapter bundle as a systemd unit on port 3000, static
 * assets baked into the unit. Pages render on demand by default
 * (`output: "server"`); `output: "static"` in your `astro.config.*` or
 * `astro: { output: "static" }` prerenders every page and deploys
 * assets-only.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/node` deploy target. Your
 * `astro.config.*` must not declare an adapter.
 *
 *
 * ### Creating Astro Sites
 * **Example:** Basic Astro App
 * ```typescript
 * const site = yield* Hetzner.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.Astro("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 *
 * ### Static Sites
 * **Example:** Fully Static Astro Site
 * ```typescript
 * const site = yield* Hetzner.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Astro = (id: string, props: AstroProps = {}) =>
  resolveAstroOutput({ rootDir: props.rootDir, output: props.astro?.output }).pipe(
    Effect.flatMap((output) =>
      makeFrameworkSite(id, props, {
        name: "Astro",
        framework: ASTRO_FRAMEWORK_SPECIFIER,
        target: ASTRO_NODE_TARGET_SPECIFIER,
        options: { astro: { ...props.astro, output } },
        static: output === "static" ? staticConfigFromAssets(props.assets) : undefined,
      }),
    ),
    Namespace.push(id),
  );
