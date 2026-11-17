import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { resolveAstroOutput } from "alchemy/Website/AstroOutput";
import * as Effect from "effect/Effect";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/astro";

/** The AWS Lambda deploy target for the Astro build. */
export const ASTRO_AWS_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/astro/aws";

/** The Node deploy target for the Lambda Web Function server (the default). */
export const ASTRO_WEB_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/astro/node";

export type AstroProps = FrameworkSiteProps<{
  // Astro is configured in YOUR `astro.config.*`, which loads natively —
  // this resource only deploys it. The `astro` bag is a deploy-time
  // overlay merged OVER the file for values a config file cannot hold
  // (per-stage values, other resources' Outputs).
  /**
   * Deploy-time Astro config overrides, merged OVER your natively-loaded
   * `astro.config.*` (values here win). Use it for values that vary per
   * stage or derive from other resources' Outputs — everything else
   * belongs in the config file.
   */
  astro?: {
    /** Deployed URL origin (astro's `site`). */
    site?: string;
    /** Base path the site is served from (astro's `base`). */
    base?: string;
    /**
     * Astro output target — a deploy-topology decision (whether a
     * server function exists). `"server"` renders pages on demand in
     * the Lambda; individual pages opt into prerendering with
     * `export const prerender = true`. `"static"` prerenders every
     * page at build time and deploys assets-only (no Lambda).
     * Overrides the `output` in your `astro.config.*`; leave it unset to
     * use the file's value.
     * @default the config file's `output`, else `"server"`
     */
    output?: "server" | "static";
    /** Source directory (astro's `srcDir`). */
    srcDir?: string;
    /** Public assets directory (astro's `publicDir`). */
    publicDir?: string;
    /** Build output directory (astro's `outDir`). */
    outDir?: string;
    /** Trailing-slash handling (astro's `trailingSlash`). */
    trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Path to an alternate astro config file, relative to `rootDir`.
   * Defaults to astro's own config discovery.
   */
  config?: string;
  /**
   * Serve the built error page (e.g. astro's `404.html`) for requests that
   * match no uploaded file. Only applies to `output: "static"`
   * sites — a server-backed site forwards misses to the Lambda instead.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404. Only applies
   * to `output: "static"` sites.
   */
  spa?: boolean;
}>;

/**
 * Deploy an [Astro](https://astro.build) application to AWS: the server
 * bundle on a Lambda Web Function, static assets (prerendered pages
 * included) in S3, and a CloudFront distribution whose edge router serves
 * uploaded files from S3 and forwards everything else to the server.
 *
 * The server runs on a Lambda Web Function: the framework's Node server
 * (built with the `@alchemy.run/frontend-frameworks/astro/node` deploy
 * target) serves many requests per environment and streams responses. Set
 * `server: "function"` to use a Lambda Function behind a streaming Function
 * URL instead, built with the `/aws` target below, for Regions without Web
 * Functions.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/aws` deploy target (a wrangler-free
 * AWS Lambda adapter is injected — your `astro.config.*` must not declare
 * one) — the package must be installed in your project.
 *
 * Pages render on demand by default (`output: "server"`); pages that
 * `export const prerender = true` are prerendered at build time and served
 * from S3. When your `astro.config.*` or `astro: { output: "static" }`
 * declares a static site, every page is prerendered and the deploy is
 * assets-only — no Lambda.
 *
 * Your `astro.config.*` is the home for Astro configuration and loads
 * natively; the `astro` prop is a deploy-time override bag merged OVER
 * the file for values that vary per stage or derive from other
 * resources' Outputs. `config` points at an alternate config file
 * (relative to `rootDir`).
 *
 * ### Creating Astro Sites
 * **Example:** Basic Astro App
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Per-stage site URL override
 * ```typescript
 * const site = yield* AWS.Website.Astro("Blog", {
 *   rootDir: "./blog",
 *   astro: { site: "https://blog.example.com" },
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Static Sites
 * **Example:** Fully Static Astro Site
 * ```typescript
 * const site = yield* AWS.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.Astro("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Astro = (id: string, props: InputProps<AstroProps, "server"> = {}) => {
  const p = props as AstroProps;
  // The prop wins, then the config file's `output`, then `"server"` —
  // astro's own zero-config default is `"static"`. Resolved here because
  // an assets-only site creates no Lambda.
  return resolveAstroOutput({ rootDir: p.rootDir, config: p.config, output: p.astro?.output }).pipe(
    Effect.flatMap((output) =>
      makeFrameworkSite(id, props, {
        name: "Astro",
        framework: ASTRO_FRAMEWORK_SPECIFIER,
        target: ASTRO_AWS_TARGET_SPECIFIER,
        webTarget: ASTRO_WEB_TARGET_SPECIFIER,
        options: { astro: { ...p.astro, output }, config: p.config },
        static: output === "static" ? { spa: p.spa, errorPage: p.errorPage } : undefined,
      }),
    ),
    Namespace.push(id),
  );
};
