import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The Next.js-on-Node framework module (`next build` + a custom
 * `next({ dev: false })` server). Not OpenNext.
 */
export const NEXTJS_NODE_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/nextjs/node";

export interface NextjsProps extends FrameworkSiteProps {}

/**
 * Deploy a Next.js application to Fly as a long-running Node process:
 * `next build`, then a serve entry that `import("next")` +
 * `next({ dev: false }).prepare()` + `getRequestHandler()`. The `.next`
 * output (and `public/` when present) is baked into the image; `next` is
 * installed unbundled.
 *
 * Do not use OpenNext AWS/CF wrappers — those are Lambda/workerd.
 *
 * During `alchemy dev` the site is `next dev` and no cloud resources are
 * declared; `Alchemy.remote()` opts back into the live Service path.
 *
 *
 * ### Creating Next.js Sites
 * **Example:** Basic Next.js App
 * ```typescript
 * const site = yield* Fly.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Fly.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  frameworkSite(id, props, {
    name: "Next.js",
    framework: NEXTJS_NODE_FRAMEWORK_SPECIFIER,
    target: NEXTJS_NODE_FRAMEWORK_SPECIFIER,
    install: ["next", "react", "react-dom"],
    skipClientAssets: true,
  });
