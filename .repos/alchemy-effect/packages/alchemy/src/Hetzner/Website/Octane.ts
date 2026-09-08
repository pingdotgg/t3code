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
 * Deploy an [OctaneJS](https://octanejs.dev) application to a Hetzner
 * Cloud Server: Octane's SSR server as a systemd unit on port 3000,
 * static assets baked into the unit.
 *
 * The project's `octane.config.ts` must select the Node marker adapter:
 *
 * ```ts
 * import { node } from "@alchemy.run/frontend-frameworks/octane/node-adapter";
 * import { defineConfig } from "@octanejs/vite-plugin";
 *
 * export default defineConfig({
 *   adapter: node(),
 * });
 * ```
 *
 *
 * ### Creating Octane Sites
 * **Example:** Basic Octane App
 * ```typescript
 * const site = yield* Hetzner.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.Octane("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
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
