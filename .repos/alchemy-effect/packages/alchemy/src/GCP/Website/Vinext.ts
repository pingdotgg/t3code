import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The vinext-on-Node framework module (vinext's Vite build +
 * `startProdServer`). Not the Cloudflare Worker source.
 */
export const VINEXT_NODE_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/node";

export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a [vinext](https://vinext.dev) application to Cloud Run as a
 * long-running Node process: vinext's Vite build, then vinext's production
 * server (`startProdServer`). The `dist/` output is baked into the
 * image; `vinext`, `react`, `react-dom`, and `react-server-dom-webpack`
 * are installed with `npm install` rather than bundled.
 *
 * Do not use the Cloudflare Worker entry (`vinext/server/fetch-handler`)
 * — that is workerd.
 *
 * During `alchemy dev` the site is `vinext dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live Cloud Run
 * service.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* GCP.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Warm Instance with More Memory
 * ```typescript
 * const site = yield* GCP.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   scaling: { minInstanceCount: 1 },
 *   resources: { limits: { cpu: "1", memory: "1Gi" } },
 * });
 * ```
 *
 * ### Data Cache
 * **Example:** Redis data cache
 * ISR / `"use cache"` default to in-process memory, which Cloud Run
 * instances do not share. Set `env.REDIS_URL` for a durable Redis store;
 * the adapter is injected automatically.
 * ```typescript
 * const site = yield* GCP.Website.Vinext("Web", {
 *   env: {
 *     REDIS_URL: "redis://10.0.0.3:6379",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vinext = (id: string, props: VinextProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vinext",
    framework: VINEXT_NODE_FRAMEWORK_SPECIFIER,
    target: VINEXT_NODE_FRAMEWORK_SPECIFIER,
    install: ["vinext", "react", "react-dom", "react-server-dom-webpack"],
  }).pipe(Namespace.push(id));
