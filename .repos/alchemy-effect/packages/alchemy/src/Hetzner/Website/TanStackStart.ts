import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the TanStack Start build. */
export const TANSTACK_START_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/tanstack-start";

/** The Node container deploy target for the TanStack Start build. */
export const TANSTACK_START_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/tanstack-start/node";

export interface TanStackStartProps extends FrameworkSiteProps {}

/**
 * Deploy a [TanStack Start](https://tanstack.com/start) application to a
 * Hetzner Cloud Server: the SSR server as a systemd unit on port 3000,
 * static assets baked into the unit.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/tanstack-start` with the
 * `@alchemy.run/frontend-frameworks/tanstack-start/node` deploy target —
 * both must be installed in your project, alongside `@tanstack/react-start`
 * (or `@tanstack/solid-start`) and `vite`.
 *
 * Your `vite.config.ts` needs no adapter wiring: TanStack Start is pure
 * Vite, so the integration drives the project's own `vite build`, forces
 * the SSR bundle to be self-contained, and wraps its fetch handler as a
 * Node HTTP server.
 *
 *
 * ### Creating TanStack Start Sites
 * **Example:** Basic TanStack Start App
 * ```typescript
 * const site = yield* Hetzner.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Hetzner.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * **Example:** Read An Environment Variable From A Server Function
 * ```typescript
 * // src/routes/index.tsx
 * const getApiBase = createServerFn({ method: "GET" }).handler(() => ({
 *   apiBase: process.env.API_BASE,
 * }));
 * ```
 *
 * @resource
 * @product Website
 */
export const TanStackStart = (id: string, props: TanStackStartProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "TanStackStart",
    framework: TANSTACK_START_FRAMEWORK_SPECIFIER,
    target: TANSTACK_START_NODE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
