import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite } from "./FrameworkSite.ts";
import {
  VITE_AWS_TARGET_SPECIFIER,
  VITE_FRAMEWORK_SPECIFIER,
  viteFrameworkOptions,
  type ViteProps,
} from "./Vite.ts";

/**
 * Props for {@link Foldkit}. A Foldkit app is a plain Vite project, so the
 * surface is {@link ViteProps} — `rootDir`, `vite`, `domain`, `spa`,
 * `errorPage`, and the rest of the shared website props.
 */
export interface FoldkitProps extends ViteProps {}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to AWS: the client build in
 * S3 behind a CloudFront distribution. Foldkit is an Elm-architecture
 * frontend framework built on Effect, and its apps are client-only Vite
 * projects — so the deployment is assets-only and never creates a server
 * function.
 *
 * The Foldkit Vite plugin lives in your project's own `vite.config.*`,
 * which loads natively. The build runs through
 * `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/aws` deploy target — the package
 * must be installed in your project. Input files are content-hashed so
 * unchanged projects skip the build and deploy entirely.
 *
 * Foldkit apps route on the client, so `spa` defaults on: unmatched paths
 * serve `index.html` with a `200` and the Foldkit runtime resolves the
 * route once the app boots.
 *
 * During `alchemy dev` the site is Vite's own dev server — Foldkit's HMR
 * and devtools wiring work unchanged — and no AWS resources are created.
 * `Alchemy.remote()` opts back into the full deployment.
 *
 * ### Creating Foldkit Sites
 * **Example:** Basic Foldkit App
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
 * ### Deep Links
 * A deep link like `/counter/42` arrives at the edge as a request for a
 * file that does not exist. `spa` is on by default so the shell is served
 * instead of a 404. An app that ships a real 404 page opts out with
 * `errorPage` — the two are mutually exclusive.
 *
 * **Example:** Serving a Real 404 Page
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Sharing a Router
 * **Example:** Serve Through an Existing AWS.Website.Router
 * ```typescript
 * const router = yield* AWS.Website.Router("Router", {});
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   domain: { router },
 * });
 * ```
 *
 * ### Build Configuration
 * Vite configuration (the Foldkit plugin included) lives in your
 * project's own `vite.config.*`. The `vite` bag holds deploy-time
 * overrides merged over that file, and `config` selects an alternate
 * config file.
 *
 * **Example:** Deploy-Time Base Path Override
 * ```typescript
 * const site = yield* AWS.Website.Foldkit("Web", {
 *   vite: { base: "/app/" },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Foldkit's Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (Foldkit HMR included); no bucket or distribution is
 * // created.
 * const site = yield* AWS.Website.Foldkit("Web");
 * ```
 *
 * @resource
 */
export const Foldkit = (id: string, props: InputProps<FoldkitProps> = {}) => {
  const p = props as FoldkitProps;
  return makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_AWS_TARGET_SPECIFIER,
    options: viteFrameworkOptions(p),
    // Foldkit is client-only: the whole deployable output is the client
    // build, so the deploy never creates a server function. Foldkit routes
    // on the client, so `spa` defaults on — but yields to an explicit
    // `errorPage` (the two are mutually exclusive downstream).
    static: {
      spa: p.spa ?? (p.errorPage === undefined ? true : undefined),
      errorPage: p.errorPage,
    },
  }).pipe(Namespace.push(id));
};
