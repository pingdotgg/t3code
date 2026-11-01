import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SolidStart build. */
export const SOLIDSTART_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart";

/** The Node container deploy target for the SolidStart build. */
export const SOLIDSTART_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart/node";

export interface SolidStartProps extends FrameworkSiteProps {
  /**
   * Nitro options forwarded into the nitro plugin the integration appends
   * (prerendering, route rules, storage, ...). `preset` is owned by the
   * Node deploy target and may not be set here. JSON-serializable values
   * only — no functions or plugin instances.
   *
   * This is a prop (rather than project config) because the integration
   * owns the nitro plugin instance: a `nitroV2Plugin()` in your project's
   * `vite.config.*` is rejected, so this prop is the one home for nitro
   * options — and it accepts values derived from other resources' Outputs,
   * which a config file cannot.
   */
  nitro?: Record<string, unknown>;
}

/**
 * Deploy a [SolidStart](https://start.solidjs.com) application to Railway:
 * the SSR server plus client assets (prerendered pages included) on one
 * `Railway.Service`.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/solidstart` with
 * the `@alchemy.run/frontend-frameworks/solidstart/node` deploy target —
 * both must be installed in your project, alongside `@solidjs/start` and
 * `@solidjs/vite-plugin-nitro-2`.
 *
 * Your `vite.config.ts` needs no adapter wiring: the integration drives the
 * project's own `vite build` and appends its own nitro plugin instance
 * carrying nitro's `node` preset.
 *
 * During `alchemy dev` the site is SolidStart's own Vite dev server and no
 * cloud resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * ### Creating SolidStart Sites
 * **Example:** Basic SolidStart App
 * ```typescript
 * const site = yield* Railway.Website.SolidStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Railway.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Railway.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   env: {
 *     GREETING: "Hello from SolidStart on Railway!",
 *   },
 * });
 * ```
 *
 * ### Prerendering
 * The integration owns the nitro plugin instance (a `nitroV2Plugin()` in
 * your `vite.config.*` is rejected), so nitro options — prerendering
 * included — go on the `nitro` prop. Prerendered pages are baked into the
 * Service image and served as static files.
 *
 * **Example:** Prerender Routes
 * ```typescript
 * const site = yield* Railway.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   nitro: { prerender: { routes: ["/", "/about"] } },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const SolidStart = (id: string, props: SolidStartProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "SolidStart",
    framework: SOLIDSTART_FRAMEWORK_SPECIFIER,
    target: SOLIDSTART_NODE_TARGET_SPECIFIER,
    options: { nitro: props.nitro },
  }).pipe(Namespace.push(id));
