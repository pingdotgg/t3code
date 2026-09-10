import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the TanStack Start build. */
export const TANSTACK_START_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/tanstack-start";

/** The AWS Lambda deploy target for the TanStack Start build. */
export const TANSTACK_START_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/tanstack-start/aws";

export interface TanStackStartProps extends FrameworkSiteProps {}

/**
 * Deploy a [TanStack Start](https://tanstack.com/start) application to AWS:
 * the SSR server on a streaming Lambda Function URL, client assets in S3,
 * and a CloudFront distribution whose edge router serves uploaded files from
 * S3 and forwards everything else to the server.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/tanstack-start` with the
 * `@alchemy.run/frontend-frameworks/tanstack-start/aws` deploy target — both
 * must be installed in your project, alongside `@tanstack/react-start` (or
 * `@tanstack/solid-start`) and `vite`.
 *
 * Your `vite.config.ts` needs no adapter wiring: TanStack Start is pure
 * Vite, so the integration drives the project's own `vite build`, forces the
 * SSR bundle to be self-contained, and wraps its fetch handler as a
 * streaming Lambda handler.
 *
 * ### Creating TanStack Start Sites
 * **Example:** Basic TanStack Start App
 * ```typescript
 * const site = yield* AWS.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.TanStackStart("Web", {
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
 * const site = yield* AWS.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
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
 * ### Shared Router
 * **Example:** Serve Through An Existing Router
 * ```typescript
 * const router = yield* AWS.Website.Router("FrontDoor", {});
 *
 * const site = yield* AWS.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   domain: { router },
 * });
 * ```
 *
 * @resource
 */
export const TanStackStart = (
  id: string,
  props: InputProps<TanStackStartProps> = {},
) =>
  makeFrameworkSite(id, props, {
    name: "TanStackStart",
    framework: TANSTACK_START_FRAMEWORK_SPECIFIER,
    target: TANSTACK_START_AWS_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
