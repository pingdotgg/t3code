import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/octane";

/** The Node container deploy target for the Octane build. */
export const OCTANE_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/octane/node";

export interface OctaneProps extends FrameworkSiteProps {}

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to Cloud Run: Octane's
 * SSR server in a Cloud Run container, static assets baked into the image.
 *
 * `GCP.Website.Octane` selects hosting and automatically wraps Octane's
 * default native Node output. Keep compiler and route settings in
 * `octane.config.ts` without an adapter. The legacy Node marker adapter
 * remains optional for existing projects.
 *
 * ### Creating Octane Sites
 * **Example:** Basic Octane App
 * ```typescript
 * const site = yield* GCP.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Warm Instance with More Memory
 * ```typescript
 * const site = yield* GCP.Website.Octane("Web", {
 *   rootDir: "./app",
 *   scaling: { minInstanceCount: 1 },
 *   resources: { limits: { cpu: "1", memory: "1Gi" } },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  frameworkSite(id, props, {
    name: "Octane",
    framework: OCTANE_FRAMEWORK_SPECIFIER,
    target: OCTANE_NODE_TARGET_SPECIFIER,
  });
