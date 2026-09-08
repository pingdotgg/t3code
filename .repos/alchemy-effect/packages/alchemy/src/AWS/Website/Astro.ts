import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro";

/** The AWS Lambda deploy target for the Astro build. */
export const ASTRO_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro/aws";

export interface AstroProps extends FrameworkSiteProps {
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
     * Supersedes a file-level `output`.
     * @default "server"
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
   * match no uploaded file. Only applies to `astro: { output: "static" }`
   * sites — a server-backed site forwards misses to the Lambda instead.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404. Only applies
   * to `astro: { output: "static" }` sites.
   */
  spa?: boolean;
}

/**
 * Deploy an [Astro](https://astro.build) application to AWS: the server
 * bundle on a streaming Lambda Function URL, static assets (prerendered
 * pages included) in S3, and a CloudFront distribution whose edge router
 * serves uploaded files from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/aws` deploy target (a wrangler-free
 * AWS Lambda adapter is injected — your `astro.config.*` must not declare
 * one) — the package must be installed in your project.
 *
 * Pages render on demand by default (`output: "server"`); pages that
 * `export const prerender = true` are prerendered at build time and served
 * from S3. With `astro: { output: "static" }` every page is prerendered
 * and the deploy is assets-only — no Lambda.
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
export const Astro = (id: string, props: InputProps<AstroProps> = {}) => {
  const p = props as AstroProps;
  // Server output is the documented default: astro's own zero-config
  // default is `"static"`. The inline config merges OVER the project's
  // `astro.config.*`, so an explicit file-level `output` is superseded;
  // opt into a fully prerendered site with `astro: { output: "static" }`.
  const output = p.astro?.output ?? "server";
  return makeFrameworkSite(id, props, {
    name: "Astro",
    framework: ASTRO_FRAMEWORK_SPECIFIER,
    target: ASTRO_AWS_TARGET_SPECIFIER,
    options: { astro: { ...p.astro, output }, config: p.config },
    static:
      output === "static" ? { spa: p.spa, errorPage: p.errorPage } : undefined,
  }).pipe(Namespace.push(id));
};
