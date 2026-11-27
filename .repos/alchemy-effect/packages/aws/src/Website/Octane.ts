import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/octane";

/** The AWS Lambda deploy target for the Octane build. */
export const OCTANE_AWS_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/octane/aws";

/** The Node deploy target for the Lambda Web Function server (the default). */
export const OCTANE_WEB_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/octane/node";

export type OctaneProps = FrameworkSiteProps<{
  /**
   * Project root directory (the directory containing `vite.config.ts` and
   * `octane.config.ts`).
   * @default "."
   */
  rootDir?: string;
}>;

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to AWS: Octane's
 * SSR server on a Lambda Web Function, static assets in S3, and a CloudFront
 * distribution whose edge router serves uploaded files from S3 and forwards
 * everything else to the server.
 *
 * The server runs on a Lambda Web Function: the framework's Node server
 * (built with the `@alchemy.run/frontend-frameworks/octane/node` deploy
 * target) serves many requests per environment and streams responses. Set
 * `server: "function"` to use a Lambda Function behind a streaming Function
 * URL instead, built with the `/aws` target below, for Regions without Web
 * Functions.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/octane` with the
 * `@alchemy.run/frontend-frameworks/octane/aws` deploy target — the project's
 * own `vite build` (with `@octanejs/vite-plugin`) produces the
 * default native Node server bundle, and the target's finishing pass
 * automatically wraps its fetch handler as a streaming Lambda handler.
 * `AWS.Website.Octane` selects hosting; keep native compiler and route
 * settings in `octane.config.ts` without an adapter. The legacy AWS marker
 * adapter remains optional for existing projects.
 *
 * ### Creating Octane Sites
 * **Example:** Basic Octane App
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Octane("Web", {
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
 * const site = yield* AWS.Website.Octane("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Octane = (id: string, props: InputProps<OctaneProps, "server"> = {}) =>
  makeFrameworkSite(id, props, {
    name: "Octane",
    framework: OCTANE_FRAMEWORK_SPECIFIER,
    target: OCTANE_AWS_TARGET_SPECIFIER,
    webTarget: OCTANE_WEB_TARGET_SPECIFIER,
    // The SSR entry reads `index.html` beside itself at runtime.
    webPrebuilt: true,
  }).pipe(Namespace.push(id));
