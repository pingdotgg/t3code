import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SvelteKit build. */
export const SVELTEKIT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit";

/** The AWS Lambda deploy target for the SvelteKit build. */
export const SVELTEKIT_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit/aws";

export interface SvelteKitProps extends FrameworkSiteProps {
  /**
   * SvelteKit config overrides for the `sveltekit(...)` plugin call, merged
   * over the options of the user's own call (these win). JSON-serializable
   * only — no `preprocess`/`vitePlugin`/functions; construction-time options
   * (`preprocess`, `extensions`, `compilerOptions`, `vitePlugin`) can only
   * apply when no user `vite.config.*` exists. The `adapter` field is
   * always owned by alchemy.
   */
  kit?: Record<string, unknown>;
}

/**
 * Deploy a SvelteKit application to AWS: kit's SSR server on a streaming
 * Lambda Function URL, static assets (prerendered pages included) in S3,
 * and a CloudFront distribution whose edge router serves uploaded files
 * from S3 and forwards everything else to the server.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/sveltekit` with the
 * `@alchemy.run/frontend-frameworks/sveltekit/aws` deploy target (an in-memory
 * kit adapter emitting a streaming Lambda handler) — both must be
 * installed in your project.
 *
 * ### Creating SvelteKit Sites
 * **Example:** Basic SvelteKit App
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
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
 * const site = yield* AWS.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   memorySize: 2048,
 *   env: {
 *     API_BASE: api.url,
 *   },
 * });
 * ```
 *
 * ### Kit Overrides
 * Kit options live in the `sveltekit(...)` call in your `vite.config.ts`,
 * which loads natively. The `kit` prop is a deploy-time override bag
 * merged over your own options (the prop wins) — useful for per-stage
 * values the config file can't compute. JSON-serializable values only.
 *
 * **Example:** Deploy-time kit overrides
 * ```typescript
 * const site = yield* AWS.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   kit: {
 *     paths: { base: "/docs" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SvelteKit = (
  id: string,
  props: InputProps<SvelteKitProps> = {},
) => {
  const p = props as SvelteKitProps;
  return makeFrameworkSite(id, props, {
    name: "SvelteKit",
    framework: SVELTEKIT_FRAMEWORK_SPECIFIER,
    target: SVELTEKIT_AWS_TARGET_SPECIFIER,
    options: { kit: p.kit },
  }).pipe(Namespace.push(id));
};
