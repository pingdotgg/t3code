import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the React Router build. */
export const REACT_ROUTER_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router";

/** The Node container deploy target for the React Router build. */
export const REACT_ROUTER_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router/node";

export interface ReactRouterProps extends FrameworkSiteProps {}

/**
 * Deploy a [React Router](https://reactrouter.com) v7 app (framework mode)
 * to Fly: the SSR server on a Machine, static assets baked into the image,
 * served assets-first then the framework handler.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/react-router` with the
 * `@alchemy.run/frontend-frameworks/react-router/node` deploy target — both
 * must be installed in your project, alongside `@react-router/dev`,
 * `react-router`, and `vite`.
 *
 * Your `vite.config.ts` needs no adapter wiring. React Router's server
 * build is a `ServerBuild` manifest rather than a request handler, so the
 * integration wraps the manifest with `createRequestHandler` and packages
 * the resulting fetch handler as a Node HTTP server on port 3000.
 *
 * React Server Components (React Router's `unstable` RSC plugin) and
 * multi-environment builds are not supported yet — the build fails with an
 * actionable error when more than one server entry is emitted.
 *
 *
 * ### Creating React Router Sites
 * **Example:** Basic React Router App
 * ```typescript
 * const site = yield* Fly.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Fly.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Fly.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   env: {
 *     GREETING: "Hello from React Router on Fly!",
 *   },
 * });
 * ```
 *
 * **Example:** Read An Environment Variable From A Loader
 * ```typescript
 * // app/routes/home.tsx
 * export function loader() {
 *   return { greeting: process.env.GREETING ?? "Hello!" };
 * }
 * ```
 *
 * @resource
 * @product Website
 */
export const ReactRouter = (id: string, props: ReactRouterProps = {}) =>
  frameworkSite(id, props, {
    name: "ReactRouter",
    framework: REACT_ROUTER_FRAMEWORK_SPECIFIER,
    target: REACT_ROUTER_NODE_TARGET_SPECIFIER,
  });
