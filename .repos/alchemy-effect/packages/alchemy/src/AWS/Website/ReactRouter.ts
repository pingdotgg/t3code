import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the React Router build. */
export const REACT_ROUTER_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router";

/** The AWS Lambda deploy target for the React Router build. */
export const REACT_ROUTER_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router/aws";

export interface ReactRouterProps extends FrameworkSiteProps {}

/**
 * Deploy a [React Router](https://reactrouter.com) v7 app (framework mode)
 * to AWS: the SSR server on a streaming Lambda Function URL, client assets
 * in S3, and a CloudFront distribution whose edge router serves uploaded
 * files from S3 and forwards everything else to the server.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/react-router` with the
 * `@alchemy.run/frontend-frameworks/react-router/aws` deploy target — both
 * must be installed in your project, alongside `@react-router/dev`,
 * `react-router`, and `vite`.
 *
 * Your `vite.config.ts` needs no adapter wiring. React Router's server
 * build is a `ServerBuild` manifest rather than a request handler, so the
 * integration makes the server pass's build input a module that wraps the
 * manifest with `createRequestHandler`, forces the SSR bundle to be
 * self-contained, and packages the resulting fetch handler as a streaming
 * Lambda handler.
 *
 * React Server Components (React Router's `unstable` RSC plugin) and
 * multi-environment builds are not supported yet — the build fails with an
 * actionable error when more than one server entry is emitted.
 *
 * ### Creating React Router Sites
 * **Example:** Basic React Router App
 * ```typescript
 * const site = yield* AWS.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Tune The Server Function
 * ```typescript
 * const site = yield* AWS.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
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
 * ### Shared Router
 * **Example:** Serve Through An Existing Router
 * ```typescript
 * const router = yield* AWS.Website.Router("FrontDoor", {});
 *
 * const site = yield* AWS.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   domain: { router },
 * });
 * ```
 *
 * @resource
 */
export const ReactRouter = (
  id: string,
  props: InputProps<ReactRouterProps> = {},
) =>
  makeFrameworkSite(id, props, {
    name: "ReactRouter",
    framework: REACT_ROUTER_FRAMEWORK_SPECIFIER,
    target: REACT_ROUTER_AWS_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
