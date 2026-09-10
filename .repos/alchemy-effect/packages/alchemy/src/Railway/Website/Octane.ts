import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/octane";

/** The Node container deploy target for the Octane build. */
export const OCTANE_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/octane/node";

export interface OctaneProps extends FrameworkSiteProps {}

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to Railway:
 * Octane's SSR server plus client assets on one `Railway.Service`.
 *
 * The project's `octane.config.ts` must select the Node marker adapter:
 *
 * ```ts
 * import { node } from "@alchemy.run/frontend-frameworks/octane/node-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: node(),
 *   // ...
 * });
 * ```
 *
 * During `alchemy dev` the site is Octane/Vite's own dev server and no
 * cloud resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * ### Creating Octane Sites
 * **Example:** Basic Octane App
 * ```typescript
 * const site = yield* Railway.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Railway.Website.Octane("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Octane",
    framework: OCTANE_FRAMEWORK_SPECIFIER,
    target: OCTANE_NODE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
