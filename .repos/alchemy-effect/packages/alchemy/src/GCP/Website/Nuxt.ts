import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Nuxt build. */
export const NUXT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nuxt";

/** The Node container deploy target for the Nuxt build. */
export const NUXT_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/nuxt/node";

export interface NuxtProps extends FrameworkSiteProps {
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (highest-priority layer). `nitro.preset` is owned by the Node deploy
   * target and may not be set here.
   */
  nuxt?: Record<string, unknown>;
}

/**
 * Deploy a Nuxt application to Cloud Run: the nitro Node server in a Cloud Run container,
 * static assets (prerendered pages included) baked into the image.
 *
 *
 * ### Creating Nuxt Sites
 * **Example:** Basic Nuxt App
 * ```typescript
 * const site = yield* GCP.Website.Nuxt("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Warm Instance with More Memory
 * ```typescript
 * const site = yield* GCP.Website.Nuxt("Web", {
 *   rootDir: "./app",
 *   scaling: { minInstanceCount: 1 },
 *   resources: { limits: { cpu: "1", memory: "1Gi" } },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nuxt = (id: string, props: NuxtProps = {}) =>
  frameworkSite(id, props, {
    name: "Nuxt",
    framework: NUXT_FRAMEWORK_SPECIFIER,
    target: NUXT_NODE_TARGET_SPECIFIER,
    options: props.nuxt ? { nuxt: props.nuxt } : undefined,
  });
