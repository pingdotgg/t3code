import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import { viteFrameworkOptions, type ViteProps } from "./Vite.ts";

/** The framework-integration package that drives the Foldkit build. */
export const FOLDKIT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit";

/** The AWS Lambda deploy target for the Foldkit build (`server: "function"`). */
export const FOLDKIT_AWS_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit/aws";

/** The Node deploy target for the Lambda Web Function server (the default). */
export const FOLDKIT_WEB_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit/node";

/** Configuration for a Foldkit website on AWS. */
export type FoldkitProps = FrameworkSiteProps<
  Pick<ViteProps, "vite" | "config" | "spa" | "errorPage"> & {
    /**
     * Deployment topology, declared before building. `"server"` deploys a
     * server for SSR/hybrid routes; `"static"` deploys only prerendered
     * assets. Omit for a browser-only SPA. A server build requires an
     * explicit choice.
     */
    output?: "server" | "static";
  }
>;

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to AWS: assets in S3 behind
 * a CloudFront distribution. Browser-only apps route on the client, so
 * `spa` defaults on. With `output: "server"`, Foldkit's generated fetch
 * handler runs on a Lambda Web Function (or a Lambda Function with
 * `server: "function"`); prerendered pages and assets stay in S3.
 *
 * The Foldkit Vite plugin in your project's own `vite.config.*` owns
 * rendering and prerendering — enable `ssr.build` there for SSR or SSG.
 * The build runs through `@alchemy.run/frontend-frameworks/foldkit`, which
 * must be installed in your project. Input files are content-hashed so
 * unchanged projects skip the build and deploy entirely.
 *
 * During `alchemy dev` the site is Foldkit's own Vite dev server (HMR and
 * devtools included) and no AWS resources are created. `Alchemy.remote()`
 * opts back into the full deployment.
 *
 * ### Creating Foldkit Sites
 * **Example:** Browser-only SPA
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Server Rendering
 * Set `output: "server"` when `ssr.build` produces a server handler.
 * Prerendered routes are served from S3; every other request reaches the
 * server.
 *
 * **Example:** SSR with Prerendered Routes
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   output: "server",
 *   env: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * **Example:** SSR on a Lambda Function
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   output: "server",
 *   server: "function",
 *   memorySize: 2048,
 * });
 * ```
 *
 * ### Static Generation
 * `output: "static"` deploys only the prerendered pages; no server is
 * created.
 *
 * **Example:** Prerendered Pages Without a Server
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Docs", {
 *   output: "static",
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Deep Links
 * A deep link like `/counter/42` arrives at the edge as a request for a
 * file that does not exist. A browser-only app serves the shell instead of
 * a 404. An app that ships a real 404 page opts out with `errorPage` — the
 * two are mutually exclusive.
 *
 * **Example:** Serving a Real 404 Page
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Custom Domains
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * **Example:** Serve Through an Existing AWS.Website.Router
 * ```typescript
 * const router = yield* AWS.Website.Router("Router", {});
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   domain: { router },
 * });
 * ```
 *
 * ### Build Configuration
 * The `vite` bag holds deploy-time overrides merged over your
 * `vite.config.*`, and `config` selects an alternate config file.
 *
 * **Example:** Deploy-Time Base Path Override
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   vite: { base: "/app/" },
 * });
 * ```
 *
 * @resource
 */
export const Foldkit = (id: string, props: InputProps<FoldkitProps, "server"> = {}) => {
  const p = props as FoldkitProps;
  return makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: FOLDKIT_FRAMEWORK_SPECIFIER,
    target: FOLDKIT_AWS_TARGET_SPECIFIER,
    webTarget: FOLDKIT_WEB_TARGET_SPECIFIER,
    options: { ...viteFrameworkOptions(p), output: p.output ?? "spa" },
    // Browser-only and prerendered builds are assets-only. Browser-only
    // apps route on the client, so `spa` defaults on unless an
    // `errorPage` is set (the two are mutually exclusive downstream).
    static:
      p.output === "server"
        ? undefined
        : {
            spa: p.spa ?? (p.output === undefined && p.errorPage === undefined),
            errorPage: p.errorPage,
          },
  }).pipe(Namespace.push(id));
};
