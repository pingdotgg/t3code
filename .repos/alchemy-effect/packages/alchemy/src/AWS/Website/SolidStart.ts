import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SolidStart build. */
export const SOLIDSTART_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart";

/** The AWS Lambda deploy target for the SolidStart build. */
export const SOLIDSTART_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart/aws";

export interface SolidStartProps extends FrameworkSiteProps {
  /**
   * Nitro options forwarded into the nitro plugin the integration appends
   * (prerendering, route rules, storage, ...). `preset` is owned by the
   * deploy target and may not be set here. JSON-serializable values only —
   * no functions or plugin instances.
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
 * Deploy a [SolidStart](https://start.solidjs.com) application to AWS: the
 * SSR server on a streaming Lambda Function URL, static assets (prerendered
 * pages included) in S3, and a CloudFront distribution whose edge router
 * serves uploaded files from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/solidstart` with
 * the `@alchemy.run/frontend-frameworks/solidstart/aws` deploy target — both
 * must be installed in your project, alongside `@solidjs/start` and
 * `@solidjs/vite-plugin-nitro-2`.
 *
 * Your `vite.config.ts` needs no adapter wiring: the integration drives the
 * project's own `vite build` and appends its own nitro plugin instance
 * carrying nitro's `aws-lambda` preset with response streaming enabled.
 *
 * ### Creating SolidStart Sites
 * **Example:** Basic SolidStart App
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
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
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * ### Prerendering
 * The integration owns the nitro plugin instance (a `nitroV2Plugin()` in
 * your `vite.config.*` is rejected), so nitro options — prerendering
 * included — go on the `nitro` prop. Prerendered pages are uploaded to S3
 * and served from the edge automatically.
 *
 * **Example:** Prerender Routes
 * ```typescript
 * const site = yield* AWS.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   nitro: { prerender: { routes: ["/", "/about"] } },
 * });
 * ```
 *
 * @resource
 */
export const SolidStart = (
  id: string,
  props: InputProps<SolidStartProps> = {},
) => {
  const p = props as SolidStartProps;
  return makeFrameworkSite(id, props, {
    name: "SolidStart",
    framework: SOLIDSTART_FRAMEWORK_SPECIFIER,
    target: SOLIDSTART_AWS_TARGET_SPECIFIER,
    options: { nitro: p.nitro },
  }).pipe(Namespace.push(id));
};
