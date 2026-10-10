import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the React Router build. */
export const REACT_ROUTER_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router";

/** The Node container deploy target for the React Router build. */
export const REACT_ROUTER_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router/node";

export interface ReactRouterProps extends FrameworkSiteProps {}

/**
 * Deploy a [React Router](https://reactrouter.com) v7 app (framework mode)
 * to a Hetzner Cloud Server: the SSR server as a systemd unit on port 3000,
 * static assets baked into the unit.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/react-router` with the
 * `@alchemy.run/frontend-frameworks/react-router/node` deploy target — both
 * must be installed in your project, alongside `@react-router/dev`,
 * `react-router`, and `vite`.
 *
 * Your `vite.config.ts` needs no adapter wiring. React Router's server
 * build is a `ServerBuild` manifest rather than a request handler, so the
 * integration makes the server pass's build input a module that wraps the
 * manifest with `createRequestHandler` and packages the resulting fetch
 * handler as a Node HTTP server.
 *
 * React Server Components (React Router's `unstable` RSC plugin) and
 * multi-environment builds are not supported yet — the build fails with an
 * actionable error when more than one server entry is emitted.
 *
 *
 * ### Creating React Router Sites
 * **Example:** Basic React Router App
 * ```typescript
 * const site = yield* Hetzner.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Hetzner.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * **Example:** Read An Environment Variable From A Loader
 * ```typescript
 * // app/routes/home.tsx
 * export function loader() {
 *   return { apiBase: process.env.API_BASE ?? "unset" };
 * }
 * ```
 *
 * @resource
 * @product Website
 */
export const ReactRouter = (id: string, props: ReactRouterProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "ReactRouter",
    framework: REACT_ROUTER_FRAMEWORK_SPECIFIER,
    target: REACT_ROUTER_NODE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
